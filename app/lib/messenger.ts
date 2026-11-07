import 'server-only';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import type {
  poll_options,
  poll_votes,
  polls,
  user_message_files,
  user_message_reactions,
  user_messages,
  users,
} from '@prisma/client';
import { isoUtc, prisma } from './db';
import { fullName, initials, shortName, type CurrentUser } from './auth';
import { asUuid, compareIds } from './ids';
import { cut, DOCS_DIR, uuidError, validationError } from './news';
import { asDict, asList, pyBool } from './kb';
import { publish } from './events';
import { notifyUser } from './push';

// Общая логика мессенджера: сериализация сообщений и файлов, опросы, превью,
// фильтр треда, непрочитанное, рассылка. Ею пользуются 14 route-handler'ов.

export type MessageRow = user_messages;
export type UserRow = users;
export type FileRow = user_message_files;

/**
 * peer_key в API: id собеседника (UUID) или "general" - общий чат. В БД
 * общий чат - это peer_user_id = NULL (messenger_reads).
 */
export const GENERAL_KEY = 'general';

/** Файлы мессенджера лежат в backend/docs/messenger. */
export const UPLOAD_DIR = path.join(DOCS_DIR, 'messenger');
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
export const ALLOWED_EXT = new Set([
  ...IMAGE_EXT,
  '.pdf', '.docx', '.doc', '.txt', '.md', '.rtf', '.odt',
  '.xls', '.xlsx', '.ods', '.pptx', '.ppt', '.csv', '.zip',
]);

/** Content-Type по расширению. */
export const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv',
};

/**
 * Абсолютный путь к файлу, если он лежит внутри каталога вложений мессенджера
 * (аналог `Path(...).resolve().relative_to(_UPLOAD_DIR)`): удалять с диска можно
 * только свои файлы. На Windows сравниваем без учёта регистра.
 */
export function resolveInsideUpload(stored: string): string | null {
  if (!stored) return null;
  const target = path.resolve(stored);
  const root = path.resolve(UPLOAD_DIR);
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const a = norm(target);
  const b = norm(root);
  if (a === b) return target;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) ? target : null;
}

// доступ к строкам БД

export async function userById(id: string | null | undefined): Promise<UserRow | null> {
  if (!id) return null;
  return prisma.users.findUnique({ where: { id } });
}

export async function messageById(id: string | null | undefined): Promise<MessageRow | null> {
  if (!id) return null;
  return prisma.user_messages.findUnique({ where: { id } });
}

/** Последнее сообщение выборки (UUIDv7 растут со временем) - вместо MAX(id). */
export async function lastMessageId(where: Prisma.user_messagesWhereInput): Promise<string | null> {
  const row = await prisma.user_messages.findFirst({
    where,
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return row?.id ?? null;
}

// сериализация

export interface FileDict {
  id: string;
  name: string;
  size: number;
  is_image: boolean;
  url: string;
  download_url: string;
  created_at: string | null;
  message_id: string | null;
  w: number | null;
  h: number | null;
}

export function serializeFile(f: FileRow): FileDict {
  return {
    id: f.id,
    name: f.original_name,
    size: f.size_bytes,
    is_image: f.is_image,
    url: `/api/messenger/files/${f.id}`,
    download_url: `/api/messenger/files/${f.id}?download=1`,
    created_at: isoUtc(f.created_at),
    message_id: f.message_id,
    w: f.img_w,
    h: f.img_h,
  };
}

/**
 * peer_key сообщения с точки зрения зрителя: в общем чате - "general", иначе id
 * собеседника.
 */
export function peerKeyOf(m: MessageRow, viewerId: string): string {
  if (m.is_general) return GENERAL_KEY;
  return (m.sender_id === viewerId ? m.recipient_id : m.sender_id) ?? GENERAL_KEY;
}

/** Собеседник для таблицы messenger_reads: NULL - общий чат. */
export function peerUserIdOf(peerKey: string): string | null {
  return peerKey === GENERAL_KEY ? null : peerKey;
}

/** Список получателей события: общий чат - все активные, иначе двое. */
export async function recipientsOf(m: MessageRow): Promise<string[]> {
  if (m.is_general) {
    const rows = await prisma.users.findMany({ where: { is_active: true }, select: { id: true } });
    return rows.map((u) => u.id);
  }
  return [m.recipient_id, m.sender_id].filter((v): v is string => v !== null);
}

/** Условие выборки сообщений диалога. */
export function threadWhere(
  userId: string,
  peerId: string | null,
  general: boolean
): Prisma.user_messagesWhereInput {
  if (general) return { is_general: true };
  // Личного диалога без собеседника не бывает (CHECK is_general = recipient IS NULL).
  if (peerId === null) return { id: { in: [] } };
  return {
    is_general: false,
    OR: [
      { sender_id: userId, recipient_id: peerId },
      { sender_id: peerId, recipient_id: userId },
    ],
  };
}

/** Сообщения, которые зритель не удалял "у себя" (user_message_hidden). */
export function notHiddenFor(userId: string): Prisma.user_messagesWhereInput {
  return { hidden_for: { none: { user_id: userId } } };
}

// бот-голосующий
// Бот участвует в голосованиях как отдельная неактивная учётная запись
// (is_active=false - поэтому не попадает в список чатов). Голосует он по
// просьбе в /api/messenger/ask, и его голоса нужно правильно подписывать
// в результатах опроса.

const BOT_USERNAME = 'hr_assistant_bot';
const globalForBot = globalThis as unknown as { hrMessengerBotId?: string };

async function botUserId(): Promise<string | null> {
  if (globalForBot.hrMessengerBotId !== undefined) return globalForBot.hrMessengerBotId;
  const row = await prisma.users.findUnique({
    where: { username: BOT_USERNAME },
    select: { id: true },
  });
  // Кэшируем только удачный поиск: иначе созданный позже бот подписывался бы в
  // опросах как "-" до перезапуска.
  if (row) globalForBot.hrMessengerBotId = row.id;
  return row?.id ?? null;
}

/**
 * Учётка бота, создаётся при первом голосовании ассистента.
 * Пароль "!" невалиден для bcrypt - войти под ботом нельзя.
 */
export async function getBotUser(): Promise<UserRow> {
  const bot = await prisma.users.upsert({
    where: { username: BOT_USERNAME },
    update: {},
    create: {
      username: BOT_USERNAME,
      email: 'assistant@hr.bot.local',
      password_hash: '!',
      surname: 'Ассистент',
      name: 'HR',
      position: 'ИИ-ассистент',
      is_active: false,
      can_access_pii: false,
    },
  });
  globalForBot.hrMessengerBotId = bot.id;
  return bot;
}

// Пакетная загрузка связанных данных
// Вложения, реакции, опросы, ответы и статусы прочтения грузятся пакетно, а не
// запросом на каждое сообщение: для треда из 100 сообщений это сотни обращений
// к БД.

type OptionWithVotes = poll_options & { votes: poll_votes[] };

interface PollBundle {
  poll: polls;
  options: OptionWithVotes[];
}

interface ReplyDict {
  id: string;
  sender_name: string;
  text: string;
}

interface Bundle {
  senders: Map<string, UserRow>;
  files: Map<string, FileRow[]>;
  reactions: Map<string, user_message_reactions[]>;
  polls: Map<string, PollBundle>;
  replies: Map<string, ReplyDict>;
  /** `${userId}|${peerUserId}` -> момент прочтения (для галочек). */
  reads: Map<string, Date | null>;
  voters: Map<string, UserRow>;
  botId: string | null;
}

function groupBy<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

async function loadBundle(rows: MessageRow[]): Promise<Bundle> {
  const ids = rows.map((m) => m.id);
  const replyIds = [...new Set(rows.map((m) => m.reply_to_id).filter((v): v is string => v !== null))];

  // loadBundle зовут только с непустым списком, поэтому по ids запрашиваем всегда.
  const [files, reactions, pollRows, replySources] = await Promise.all([
    prisma.user_message_files.findMany({
      where: { message_id: { in: ids } },
      orderBy: { id: 'asc' },
    }),
    prisma.user_message_reactions.findMany({
      where: { message_id: { in: ids } },
      orderBy: { created_at: 'asc' },
    }),
    // У сообщения не больше одного опроса (polls.message_id уникален).
    prisma.polls.findMany({
      where: { message_id: { in: ids } },
      include: {
        options: {
          orderBy: { position: 'asc' },
          include: { votes: { orderBy: { created_at: 'asc' } } },
        },
      },
    }),
    replyIds.length
      ? prisma.user_messages.findMany({ where: { id: { in: replyIds } } })
      : Promise.resolve<MessageRow[]>([]),
  ]);

  const replySourceIds = replySources.map((m) => m.id);
  const replyFiles = replySourceIds.length
    ? await prisma.user_message_files.findMany({
        where: { message_id: { in: replySourceIds } },
        select: { message_id: true },
      })
    : [];

  const pollsByMessage = new Map<string, PollBundle>();
  for (const { options, ...poll } of pollRows) {
    if (poll.message_id) pollsByMessage.set(poll.message_id, { poll, options });
  }

  // Имена голосовавших нужны только в опросах с открытым списком.
  const voterIds = new Set<string>();
  for (const bundle of pollsByMessage.values()) {
    if (!bundle.poll.show_voters) continue;
    for (const o of bundle.options) for (const v of o.votes) voterIds.add(v.user_id);
  }

  const userIds = new Set<string>([
    ...rows.map((m) => m.sender_id),
    ...replySources.map((m) => m.sender_id),
    ...voterIds,
  ]);
  const userRows: UserRow[] = userIds.size
    ? await prisma.users.findMany({ where: { id: { in: [...userIds] } } })
    : [];
  const userMap = new Map(userRows.map((u) => [u.id, u]));

  // Статус "прочитано" для своих сообщений: отметка получателя по диалогу с
  // отправителем. Пары зависят только от сообщений, не от зрителя.
  const readPairs = new Map<string, { user_id: string; peer_user_id: string }>();
  for (const m of rows) {
    if (m.is_general || m.recipient_id === null) continue;
    const key = `${m.recipient_id}|${m.sender_id}`;
    if (!readPairs.has(key)) {
      readPairs.set(key, { user_id: m.recipient_id, peer_user_id: m.sender_id });
    }
  }
  const reads = new Map<string, Date | null>();
  if (readPairs.size) {
    const readRows = await prisma.messenger_reads.findMany({
      where: { OR: [...readPairs.values()] },
    });
    for (const r of readRows) reads.set(`${r.user_id}|${r.peer_user_id}`, r.last_read_at);
  }

  const replyFileIds = new Set(
    replyFiles.map((f) => f.message_id).filter((v): v is string => v !== null)
  );
  const replies = new Map<string, ReplyDict>();
  for (const src of replySources) {
    const sender = userMap.get(src.sender_id) ?? null;
    const sfm = asDict(src.forwarded_meta);
    let text: string;
    if (pyBool(sfm.system)) {
      text = src.content || '';
    } else if (Object.keys(sfm).length && !pyBool(sfm.from_user)) {
      text = pyBool(sfm.ai) ? 'Ответ ассистента' : '↪ сообщение ассистента';
    } else {
      text = (src.content || '').replace(/\n/g, ' ');
      if (!text && replyFileIds.has(src.id)) text = '📎 вложение';
    }
    replies.set(src.id, {
      id: src.id,
      sender_name: sender ? shortName(sender) : '—',
      text: cut(text, 80),
    });
  }

  return {
    senders: userMap,
    files: groupBy(files, (f) => f.message_id),
    reactions: groupBy(reactions, (r) => r.message_id),
    polls: pollsByMessage,
    replies,
    reads,
    voters: userMap,
    botId: await botUserId(),
  };
}

export interface ReactionDict {
  emoji: string;
  count: number;
  mine: boolean;
}

function aggregateReactions(
  rows: { user_id: string; emoji: string }[],
  viewerId: string
): ReactionDict[] {
  const agg = new Map<string, ReactionDict>();
  for (const r of rows) {
    let item = agg.get(r.emoji);
    if (!item) {
      item = { emoji: r.emoji, count: 0, mine: false };
      agg.set(r.emoji, item);
    }
    item.count += 1;
    if (r.user_id === viewerId) item.mine = true;
  }
  return [...agg.values()];
}

function reactionsOf(messageId: string, viewerId: string, b: Bundle): ReactionDict[] {
  return aggregateReactions(b.reactions.get(messageId) ?? [], viewerId);
}

/** Реакции сразу для нескольких зрителей (флаг "mine" у каждого свой). */
export async function reactionsForViewers(
  messageId: string,
  viewerIds: string[]
): Promise<Map<string, ReactionDict[]>> {
  const rows = await prisma.user_message_reactions.findMany({
    where: { message_id: messageId },
    orderBy: { created_at: 'asc' },
  });
  return new Map(viewerIds.map((uid) => [uid, aggregateReactions(rows, uid)]));
}

export interface PollDict {
  id: string;
  question: string;
  description: string;
  allow_multiple: boolean;
  show_voters: boolean;
  allow_change: boolean;
  allow_bot: boolean;
  options: {
    id: string;
    text: string;
    votes: number;
    mine: boolean;
    voters: { id: string; name: string; initials: string; sex: string | null; is_bot: boolean }[] | null;
  }[];
  total_votes: number;
  voted: boolean;
}

function pollOf(messageId: string, viewerId: string, b: Bundle): PollDict | null {
  const bundle = b.polls.get(messageId);
  if (!bundle) return null;
  const { poll, options } = bundle;

  const voterIds = new Set<string>();
  let voted = false;
  for (const o of options) {
    for (const v of o.votes) {
      voterIds.add(v.user_id);
      if (v.user_id === viewerId) voted = true;
    }
  }

  return {
    id: poll.id,
    question: poll.question,
    description: poll.description || '',
    allow_multiple: poll.allow_multiple,
    show_voters: poll.show_voters,
    allow_change: poll.allow_change,
    allow_bot: poll.allow_bot,
    options: options.map((o) => ({
      id: o.id,
      text: o.text,
      votes: o.votes.length,
      mine: o.votes.some((v) => v.user_id === viewerId),
      voters: poll.show_voters
        ? o.votes.map(({ user_id: uid }) => {
            const u = b.voters.get(uid);
            const isBot = uid === b.botId;
            return {
              id: uid,
              name: isBot ? 'HR-ассистент' : u ? fullName(u) : '—',
              initials: isBot ? '🤖' : u ? initials(u) : '?',
              sex: isBot ? null : (u?.sex ?? null),
              is_bot: isBot,
            };
          })
        : null,
    })),
    total_votes: voterIds.size,
    voted,
  };
}

/** Статус доставки своего сообщения (для галочек), сравнение по времени. */
function seenStatus(m: MessageRow, b: Bundle): 'seen' | 'delivered' {
  if (m.is_general) return 'delivered';
  const lastReadAt = b.reads.get(`${m.recipient_id}|${m.sender_id}`);
  if (lastReadAt && m.created_at && lastReadAt.getTime() >= m.created_at.getTime()) return 'seen';
  return 'delivered';
}

export interface MessageDict {
  id: string;
  sender_id: string;
  sender_name: string;
  sender_initials: string;
  content: string;
  forwarded: boolean;
  forwarded_meta: Record<string, unknown> | null;
  forwarded_from: unknown;
  created_at: string | null;
  mine: boolean;
  self_chat: boolean;
  peer_key: string;
  is_general: boolean;
  is_pinned: boolean;
  is_edited: boolean;
  is_ai_query: boolean;
  system: boolean;
  reply_to: ReplyDict | null;
  attachments: FileDict[];
  status: string | null;
  reactions: ReactionDict[];
  poll: PollDict | null;
}

function renderMessage(m: MessageRow, viewerId: string, b: Bundle): MessageDict {
  const mine = m.sender_id === viewerId;
  // "Заметки" (диалог с самим собой): sender == recipient. По флагу клиент
  // рисует пересланные чужие сообщения слева зелёным пузырём.
  const selfChat = !m.is_general && m.sender_id === m.recipient_id;
  const fm = asDict(m.forwarded_meta);
  const hasMeta = Object.keys(fm).length > 0;
  // "forwarded" (ассистентский пузырёк) - только для снимка ответа ИИ, не для
  // системных строк и не для пересланных сообщений пользователей (from_user).
  const isAsstFwd = hasMeta && !pyBool(fm.system) && !pyBool(fm.from_user);
  const sender = b.senders.get(m.sender_id) ?? null;

  return {
    id: m.id,
    sender_id: m.sender_id,
    sender_name: sender ? shortName(sender) : '—',
    sender_initials: sender ? initials(sender) : '?',
    content: m.content || '',
    forwarded: isAsstFwd,
    forwarded_meta: isAsstFwd ? fm : null,
    forwarded_from: fm.from_user ?? null,
    created_at: isoUtc(m.created_at),
    mine,
    self_chat: selfChat,
    peer_key: peerKeyOf(m, viewerId),
    is_general: m.is_general,
    is_pinned: m.is_pinned,
    is_edited: m.is_edited,
    is_ai_query: m.is_ai_query,
    system: hasMeta && pyBool(fm.system),
    reply_to: m.reply_to_id ? (b.replies.get(m.reply_to_id) ?? null) : null,
    attachments: (b.files.get(m.id) ?? []).map(serializeFile),
    status: mine ? seenStatus(m, b) : null,
    reactions: reactionsOf(m.id, viewerId, b),
    poll: pollOf(m.id, viewerId, b),
  };
}

/** _serialize для набора сообщений одного зрителя. */
export async function serializeMessages(
  rows: MessageRow[],
  viewerId: string
): Promise<MessageDict[]> {
  if (!rows.length) return [];
  const bundle = await loadBundle(rows);
  return rows.map((m) => renderMessage(m, viewerId, bundle));
}

export async function serializeMessage(m: MessageRow, viewerId: string): Promise<MessageDict> {
  const [dict] = await serializeMessages([m], viewerId);
  return dict;
}

/** Одно сообщение глазами разных получателей (для рассылки события). */
export async function serializeForViewers(
  m: MessageRow,
  viewerIds: string[]
): Promise<Map<string, MessageDict>> {
  const bundle = await loadBundle([m]);
  return new Map(viewerIds.map((uid) => [uid, renderMessage(m, uid, bundle)]));
}

/** Голосование сразу для нескольких зрителей (свои "mine"/"voted" у каждого). */
export async function pollForViewers(
  m: MessageRow,
  viewerIds: string[]
): Promise<Map<string, PollDict | null>> {
  const bundle = await loadBundle([m]);
  return new Map(viewerIds.map((uid) => [uid, pollOf(m.id, uid, bundle)]));
}

// превью для списка диалогов

/** _preview: текст последнего сообщения диалога. files - вложения сообщения. */
export function previewOf(m: MessageRow, viewerId: string, files: FileRow[]): string {
  const fm = asDict(m.forwarded_meta);
  if (pyBool(fm.system)) return (m.content || '').replace(/\n/g, ' ');

  let base: string;
  if (Object.keys(fm).length && !pyBool(fm.from_user)) {
    base = pyBool(fm.ai) ? 'Ответ ассистента' : '↪ пересланное сообщение ассистента';
  } else {
    // обычное или пересланное от пользователя - текст, а для вложений - метка.
    base = (m.content || '').replace(/\n/g, ' ');
    const imgs = files.filter((f) => f.is_image);
    const docs = files.filter((f) => !f.is_image);
    if (files.length) {
      const icon = imgs.length ? '🏞️ ' : docs.length ? '📄 ' : '';
      if (base) base = icon + base;
      else if (imgs.length) base = '🏞️ ' + (imgs.length === 1 ? 'Изображение' : 'Изображения');
      else if (docs.length) base = '📄 ' + (docs.length === 1 ? 'Документ' : 'Документы');
    }
  }
  if (Array.from(base).length > 60) base = cut(base, 60) + '…';
  return (m.sender_id === viewerId ? 'Вы: ' : '') + base;
}

// непрочитанное и отметки о прочтении

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/** Сдвигает отметку прочтения и гасит бейдж у самого читателя. */
export async function markRead(
  userId: string,
  peerKey: string,
  where: Prisma.user_messagesWhereInput
): Promise<void> {
  const lastId = await lastMessageId(where);
  if (lastId === null) return;

  const peerUserId = peerUserIdOf(peerKey);
  const now = new Date();
  const advance = async () => {
    const row = await prisma.messenger_reads.findFirst({
      where: { user_id: userId, peer_user_id: peerUserId },
    });
    if (!row) return false;
    await prisma.messenger_reads.update({
      where: { id: row.id },
      data: {
        // Отметка только растёт: старый клиент мог прислать запоздавшее "прочитано".
        last_read_id:
          row.last_read_id && compareIds(row.last_read_id, lastId) > 0 ? row.last_read_id : lastId,
        last_read_at: now,
      },
    });
    return true;
  };

  if (!(await advance())) {
    try {
      await prisma.messenger_reads.create({
        data: { user_id: userId, peer_user_id: peerUserId, last_read_id: lastId, last_read_at: now },
      });
    } catch (e) {
      // Параллельный запрос успел создать отметку (уникальность user+peer) - сдвигаем её.
      if (!isUniqueViolation(e)) throw e;
      await advance();
    }
  }
  // Событие самому читателю: бейдж центра уведомлений (в этой и других вкладках)
  // гаснет мгновенно. Собеседнику user_read уходит отдельно.
  publish(userId, { type: 'unread_changed', scope: 'messenger', peer_key: peerKey });
}

/** Отметка "диалог прочитан" + user_read собеседнику (галочки). */
export async function doRead(
  userId: string,
  peerId: string | null,
  general: boolean
): Promise<void> {
  if (!general && !(await userById(peerId))) return;
  const where = threadWhere(userId, peerId, general);
  await markRead(userId, general || !peerId ? GENERAL_KEY : peerId, where);
  if (!general && peerId) {
    const lastId = await lastMessageId(where);
    if (lastId) publish(peerId, { type: 'user_read', peer_key: userId, last_read_id: lastId });
  }
}

// рассылка событий

/**
 * _broadcast: доставка нового сообщения подписчикам SSE плюс системный Web
 * Push получателям (кроме автора) - уведомление приходит, даже если вкладка
 * или приложение закрыты.
 */
export async function broadcastMessage(m: MessageRow): Promise<void> {
  const uids = [...new Set(await recipientsOf(m))];
  const dicts = await serializeForViewers(m, uids);

  // Служебные строки ("закрепил(а) сообщение") push не порождают, поэтому и
  // вложения под превью для них не грузим.
  const isSystem = pyBool(asDict(m.forwarded_meta).system);
  const sender = isSystem ? null : await userById(m.sender_id);
  const files = isSystem
    ? []
    : await prisma.user_message_files.findMany({ where: { message_id: m.id } });

  for (const uid of uids) {
    publish(uid, { type: 'user_message', message: dicts.get(uid) });
    if (isSystem || uid === m.sender_id) continue;

    const from = sender ? shortName(sender) : null;
    const title = m.is_general ? 'Общий чат' : (from ?? 'Новое сообщение');
    let body = previewOf(m, uid, files);
    if (m.is_general && from) body = `${from}: ${body}`;
    notifyUser(uid, {
      title,
      body: cut(body || 'Новое сообщение', 120),
      url: '/messenger',
      tag: `msgr-${peerKeyOf(m, uid)}`,
    });
  }
}

/** Сигнал "печатает" собеседнику(ам). Не сохраняется в БД. */
export async function publishTyping(
  user: CurrentUser,
  peerId: string | null,
  general: boolean,
  isTyping: boolean
): Promise<void> {
  let recipients: string[];
  if (general) {
    const rows = await prisma.users.findMany({ where: { is_active: true }, select: { id: true } });
    recipients = rows.map((u) => u.id).filter((uid) => uid !== user.id);
  } else {
    if (!(await userById(peerId))) return;
    recipients = peerId === null ? [] : [peerId];
  }
  for (const uid of new Set(recipients)) {
    publish(uid, {
      type: 'user_typing',
      // peer_key с точки зрения получателя: 1-1 -> id отправителя, общий -> general
      peer_key: general ? GENERAL_KEY : user.id,
      sender_id: user.id,
      sender_name: shortName(user),
      sender_initials: initials(user),
      is_general: general,
      typing: Boolean(isTyping),
    });
  }
}

// снимок пересылаемого ответа ассистента

/** Снимок для пересылки: текст ответа ИИ + вложение + источники. */
export async function forwardSnapshot(chatMessageId: string): Promise<Record<string, unknown> | null> {
  const cm = await prisma.chat_messages.findUnique({
    where: { id: chatMessageId },
    include: { attachment_document: true },
  });
  if (!cm) return null;

  let attachment: { id: string; title: string; filename: string } | null = null;
  let isPii = pyBool(asDict(cm.meta).pii_doc);
  const doc = cm.attachment_document;
  if (doc) {
    attachment = {
      id: doc.id,
      title: doc.title || 'Документ',
      filename: doc.file_path ? doc.file_path.split('\\').pop()!.split('/').pop()! : '',
    };
    isPii = isPii || doc.is_pii;
  }
  const snap: Record<string, unknown> = {
    content: cm.content || '',
    attachment,
    sources: asList(cm.sources),
  };
  // ПДн-содержимое не хранится: пересылка помечается и автоудаляется по TTL.
  if (isPii) snap.pii = true;
  return snap;
}

// Разбор query-параметров

/** Необязательный UUID из query; null, если параметра нет. */
export function idQuery(
  raw: string | null,
  name: string
): { value: string | null } | { response: NextResponse } {
  if (raw === null) return { value: null };
  const id = asUuid(raw);
  return id ? { value: id } : { response: uuidError(['query', name], raw) };
}

/** `x: UUID = Query(...)` - обязательный идентификатор. */
export function requiredIdQuery(
  raw: string | null,
  name: string
): { value: string } | { response: NextResponse } {
  if (raw === null) {
    return { response: validationError(['query', name], 'missing', 'Field required', null) };
  }
  const parsed = idQuery(raw, name);
  if ('response' in parsed) return parsed;
  return { value: parsed.value as string };
}

// Разбор тела запроса
// Ошибки валидации возвращаются сразу все, списком. Типы ошибок на этих
// эндпоинтах: missing / uuid_* / string_type / bool_* / list_type.

interface FieldError {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: unknown;
}

const TRUE_STRINGS = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_STRINGS = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

export class BodyParams {
  private errors: FieldError[] = [];

  constructor(
    private readonly body: Record<string, unknown>,
    private readonly present: boolean
  ) {}

  private missing(name: string): void {
    this.errors.push({
      type: 'missing',
      loc: ['body', name],
      msg: 'Field required',
      input: this.present ? this.body : null,
    });
  }

  private fail(loc: (string | number)[], type: string, msg: string, input: unknown): void {
    this.errors.push({ type, loc, msg, input });
  }

  private has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.body, name) && this.body[name] !== undefined;
  }

  /** Идентификатор записи - строка UUID. */
  private toUuid(value: unknown, loc: (string | number)[]): string | null {
    if (typeof value !== 'string') {
      this.fail(loc, 'uuid_type', 'UUID input should be a string', value);
      return null;
    }
    const id = asUuid(value);
    if (!id) this.fail(loc, 'uuid_parsing', 'Input should be a valid UUID', value);
    return id;
  }

  private toStr(value: unknown, loc: (string | number)[]): string | null {
    if (typeof value === 'string') return value;
    this.fail(loc, 'string_type', 'Input should be a valid string', value);
    return null;
  }

  private toBool(value: unknown, loc: (string | number)[]): boolean | null {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (value === 0 || value === 1) return value === 1;
      this.fail(loc, 'bool_parsing', 'Input should be a valid boolean, unable to interpret input', value);
      return null;
    }
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (TRUE_STRINGS.has(v)) return true;
      if (FALSE_STRINGS.has(v)) return false;
      this.fail(loc, 'bool_parsing', 'Input should be a valid boolean, unable to interpret input', value);
      return null;
    }
    this.fail(loc, 'bool_type', 'Input should be a valid boolean', value);
    return null;
  }

  /** `x: UUID = Body(...)` - обязательный идентификатор. */
  uuid(name: string): string {
    if (!this.has(name)) {
      this.missing(name);
      return '';
    }
    return this.toUuid(this.body[name], ['body', name]) ?? '';
  }

  /** Необязательный UUID из тела. */
  optUuid(name: string): string | null {
    if (!this.has(name) || this.body[name] === null) return null;
    return this.toUuid(this.body[name], ['body', name]);
  }

  /** `x: str = Body(...)` / `Body(default=...)`. */
  str(name: string, fallback?: string): string {
    if (!this.has(name)) {
      if (fallback === undefined) {
        this.missing(name);
        return '';
      }
      return fallback;
    }
    return this.toStr(this.body[name], ['body', name]) ?? '';
  }

  /** `x: bool = Body(default=...)`. */
  bool(name: string, fallback: boolean): boolean {
    if (!this.has(name)) return fallback;
    const v = this.toBool(this.body[name], ['body', name]);
    return v === null ? fallback : v;
  }

  /** Необязательный список UUID из тела. */
  optUuidList(name: string): string[] | null {
    if (!this.has(name) || this.body[name] === null) return null;
    const raw = this.body[name];
    if (!Array.isArray(raw)) {
      this.fail(['body', name], 'list_type', 'Input should be a valid list', raw);
      return null;
    }
    const out: string[] = [];
    raw.forEach((item, i) => {
      const v = this.toUuid(item, ['body', name, i]);
      if (v !== null) out.push(v);
    });
    return out;
  }

  /** `x: List[str] = Body(...)`. */
  strList(name: string): string[] {
    if (!this.has(name)) {
      this.missing(name);
      return [];
    }
    const raw = this.body[name];
    if (!Array.isArray(raw)) {
      this.fail(['body', name], 'list_type', 'Input should be a valid list', raw);
      return [];
    }
    const out: string[] = [];
    raw.forEach((item, i) => {
      const v = this.toStr(item, ['body', name, i]);
      if (v !== null) out.push(v);
    });
    return out;
  }

  /** 422 со всеми накопленными ошибками либо null, если тело корректно. */
  invalid(): NextResponse | null {
    return this.errors.length ? NextResponse.json({ detail: this.errors }, { status: 422 }) : null;
  }
}

/**
 * Читает тело как объект параметров. Пустое тело допустимо: берутся значения
 * по умолчанию, а для обязательных полей - ошибка "Field required".
 */
export async function bodyParams(
  request: NextRequest
): Promise<{ params: BodyParams } | { response: NextResponse }> {
  const raw = await request.text();
  if (!raw) return { params: new BodyParams({}, false) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      response: NextResponse.json(
        { detail: [{ type: 'json_invalid', loc: ['body', 0], msg: 'JSON decode error', input: {} }] },
        { status: 422 }
      ),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      response: NextResponse.json(
        {
          detail: [
            {
              type: 'model_attributes_type',
              loc: ['body'],
              msg: 'Input should be a valid dictionary or object to extract fields from',
              input: parsed,
            },
          ],
        },
        { status: 422 }
      ),
    };
  }
  return { params: new BodyParams(parsed as Record<string, unknown>, true) };
}

// размеры изображений

/**
 * Ширина/высота картинки по заголовку файла - замена Pillow (Image.open().size),
 * серверной библиотеки обработки изображений в проекте нет. Размеры нужны, чтобы
 * клиент зарезервировал место под серый плейсхолдер до загрузки.
 *
 * Разбираются png/jpeg/gif/bmp/webp; для остальных форматов
 * (в т.ч. svg - его и Pillow не открывает) отдаём null при ошибке.
 */
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  try {
    // PNG: сигнатура + IHDR
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF87a / GIF89a
    if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // BMP
    if (buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') {
      return { w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) };
    }
    // WEBP (VP8X / VP8 / VP8L)
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
      }
      if (chunk === 'VP8 ') {
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    // JPEG: ищем маркер SOFn
    if (buf.length >= 4 && buf.readUInt16BE(0) === 0xffd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off += 1;
          continue;
        }
        const marker = buf[off + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          off += 2;
          continue;
        }
        const len = buf.readUInt16BE(off + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        if (len < 2) return null;
        off += 2 + len;
      }
      return null;
    }
  } catch {
    return null; // обрезанный/битый файл - Pillow здесь тоже упал бы
  }
  return null;
}
