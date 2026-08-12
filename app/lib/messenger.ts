import 'server-only';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type {
  Prisma,
  poll_options,
  poll_votes,
  polls,
  user_message_files,
  user_message_reactions,
  user_messages,
  users,
} from '@prisma/client';
import { prisma } from './db';
import { fullName, initials, shortName, type CurrentUser } from './auth';
import { cut, DOCS_DIR, validationError } from './news';
import { asDict, asList, pyBool, pyStr } from './kb';
import { isoUtcTz, publish } from './events';
import { notifyUser } from './push';

// Общая логика мессенджера — порт вспомогательных функций
// backend/routes/messenger.py (_serialize, _serialize_file, _poll_of,
// _reply_preview, _preview, _thread_filter, _unread_count, _mark_read,
// _recipients_of, _broadcast, _forward_snapshot).
// Вынесена сюда: этим пользуются 14 route-handler'ов.

export type MessageRow = user_messages;
export type UserRow = users;
export type FileRow = user_message_files;

export const GENERAL_KEY = 'general';

/** Файлы мессенджера лежат там же, где их кладёт FastAPI: backend/docs/messenger. */
export const UPLOAD_DIR = path.join(DOCS_DIR, 'messenger');
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
export const ALLOWED_EXT = new Set([
  ...IMAGE_EXT,
  '.pdf', '.docx', '.doc', '.txt', '.md', '.rtf', '.odt',
  '.xls', '.xlsx', '.ods', '.pptx', '.ppt', '.csv', '.zip',
]);

/** Content-Type по расширению (_MIME из Python). */
export const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv',
};

/**
 * Абсолютный путь к файлу, если он лежит внутри каталога вложений мессенджера
 * (аналог `Path(...).resolve().relative_to(_UPLOAD_DIR)`): удалять с диска можно
 * только свои файлы. На Windows сравниваем без учёта регистра, как pathlib.
 */
export function resolveInsideUpload(stored: string): string | null {
  if (!stored) return null;
  // В БД пути хранятся относительно каталога вложений; абсолютные значения —
  // записи старых версий, поддерживаем и их.
  const target = path.isAbsolute(stored) ? path.resolve(stored) : path.resolve(UPLOAD_DIR, stored);
  const root = path.resolve(UPLOAD_DIR);
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const a = norm(target);
  const b = norm(root);
  if (a === b) return target;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) ? target : null;
}

/** Абсолютный fs-путь вложения по хранимому значению (без проверки принадлежности). */
export function fromUploadPath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.resolve(UPLOAD_DIR, stored);
}

/** Вид пути для записи в БД: относительный к каталогу вложений. */
export function toUploadPath(p: string): string {
  if (!p || !path.isAbsolute(p)) return p;
  const inside = resolveInsideUpload(p);
  return inside ? path.relative(path.resolve(UPLOAD_DIR), inside) : p;
}

// ── доступ к строкам БД ────────────────────────────────────────────────────
// Аналог db.get(Model, pk): id вне диапазона int4 в БД не существует, поэтому
// сразу возвращаем null (Prisma на таком значении бросила бы исключение).

function inInt4(id: number): boolean {
  return Number.isInteger(id) && id >= -2147483648 && id <= 2147483647;
}

export async function userById(id: number | null | undefined): Promise<UserRow | null> {
  if (id === null || id === undefined || !inInt4(id)) return null;
  return prisma.users.findUnique({ where: { id } });
}

export async function messageById(id: number | null | undefined): Promise<MessageRow | null> {
  if (id === null || id === undefined || !inInt4(id)) return null;
  return prisma.user_messages.findUnique({ where: { id } });
}

// ── сериализация ───────────────────────────────────────────────────────────

export interface FileDict {
  id: number;
  name: string;
  size: number;
  is_image: boolean;
  url: string;
  download_url: string;
  created_at: string | null;
  message_id: number | null;
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
    created_at: isoUtcTz(f.created_at),
    message_id: f.message_id,
    w: f.img_w,
    h: f.img_h,
  };
}

/**
 * peer_key сообщения с точки зрения зрителя: в общем чате — «general», иначе id
 * СОБЕСЕДНИКА. Совмещает _peer_key и _pk_for из Python — они считают одно и то
 * же (`recipient if sender == viewer else sender`), просто записаны по-разному.
 */
export function peerKeyOf(m: MessageRow, viewerId: number): string {
  if (m.is_general) return GENERAL_KEY;
  return pyStr(m.sender_id === viewerId ? m.recipient_id : m.sender_id);
}

/** Список получателей события: общий чат — все активные, иначе двое. */
export async function recipientsOf(m: MessageRow): Promise<number[]> {
  if (m.is_general) {
    const rows = await prisma.users.findMany({ where: { is_active: true }, select: { id: true } });
    return rows.map((u) => u.id);
  }
  return [m.recipient_id, m.sender_id].filter((v): v is number => v !== null);
}

/**
 * Условие выборки сообщений диалога (_thread_filter).
 * peerId === null и general === false: SQLAlchemy превращает `== None` в
 * `IS NULL`, поэтому ветка «отправитель IS NULL» не даёт строк (колонка NOT
 * NULL) — оставляем только первую. Результат тот же: пустая выборка.
 */
export function threadWhere(
  userId: number,
  peerId: number | null,
  general: boolean
): Prisma.user_messagesWhereInput {
  if (general) return { is_general: true };
  if (peerId === null) return { is_general: false, sender_id: userId, recipient_id: null };
  return {
    is_general: false,
    OR: [
      { sender_id: userId, recipient_id: peerId },
      { sender_id: peerId, recipient_id: userId },
    ],
  };
}

// ── бот-голосующий ─────────────────────────────────────────────────────────
// Бот участвует в голосованиях как отдельная неактивная учётная запись
// (is_active=false — поэтому не попадает в список чатов). Голосует он по
// просьбе в /api/messenger/ask, и его голоса нужно правильно подписывать
// в результатах опроса.

const BOT_USERNAME = 'hr_assistant_bot';
const globalForBot = globalThis as unknown as { hrMessengerBotId?: number };

async function botUserId(): Promise<number | null> {
  if (globalForBot.hrMessengerBotId !== undefined) return globalForBot.hrMessengerBotId;
  const row = await prisma.users.findUnique({
    where: { username: BOT_USERNAME },
    select: { id: true },
  });
  // Кэшируем только удачный поиск. Python кэширует и промах, из-за чего
  // созданный позже бот подписывается в опросах как «—» до перезапуска.
  if (row) globalForBot.hrMessengerBotId = row.id;
  return row?.id ?? null;
}

/**
 * _get_bot_user: учётка бота, создаётся при первом голосовании ассистента.
 * Пароль «!» невалиден для bcrypt — войти под ботом нельзя.
 */
export async function getBotUser(): Promise<UserRow> {
  const bot =
    (await prisma.users.findFirst({ where: { username: BOT_USERNAME }, orderBy: { id: 'asc' } })) ??
    (await prisma.users.create({
      data: {
        username: BOT_USERNAME,
        email: 'assistant@hr.bot.local',
        password_hash: '!',
        surname: 'Ассистент',
        name: 'HR',
        patronymic: null,
        position: 'ИИ-ассистент',
        sex: null,
        is_active: false,
        is_admin: false,
        is_kb_editor: false,
        can_access_pii: false,
      },
    }));
  globalForBot.hrMessengerBotId = bot.id;
  return bot;
}

// ── пакетная загрузка связанных данных ─────────────────────────────────────
// Python на каждое сообщение делает отдельные запросы (вложения, реакции,
// опрос, ответ-на, статус прочтения). Для треда из 100 сообщений это сотни
// обращений к БД — здесь всё грузится пакетно, результат идентичен.

interface PollBundle {
  poll: polls;
  options: poll_options[];
  votes: poll_votes[];
}

interface ReplyDict {
  id: number;
  sender_name: string;
  text: string;
}

interface Bundle {
  senders: Map<number, UserRow>;
  files: Map<number, FileRow[]>;
  reactions: Map<number, user_message_reactions[]>;
  polls: Map<number, PollBundle>;
  replies: Map<number, ReplyDict>;
  /** `${userId}|${peerKey}` → момент прочтения (для галочек). */
  reads: Map<string, Date | null>;
  voters: Map<number, UserRow>;
  botId: number | null;
}

function groupBy<T>(rows: T[], key: (row: T) => number | null): Map<number, T[]> {
  const out = new Map<number, T[]>();
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
  const replyIds = [...new Set(rows.map((m) => m.reply_to_id).filter((v): v is number => v !== null))];

  // loadBundle зовут только с непустым списком, поэтому по ids запрашиваем всегда.
  const [files, reactions, pollRows, replySources] = await Promise.all([
    prisma.user_message_files.findMany({
      where: { message_id: { in: ids } },
      orderBy: { id: 'asc' },
    }),
    prisma.user_message_reactions.findMany({
      where: { message_id: { in: ids } },
      orderBy: { id: 'asc' },
    }),
    prisma.polls.findMany({ where: { message_id: { in: ids } }, orderBy: { id: 'asc' } }),
    replyIds.length
      ? prisma.user_messages.findMany({ where: { id: { in: replyIds } } })
      : Promise.resolve<MessageRow[]>([]),
  ]);

  const pollIds = pollRows.map((p) => p.id);
  const replySourceIds = replySources.map((m) => m.id);
  const [options, votes, replyFiles] = await Promise.all([
    pollIds.length
      ? prisma.poll_options.findMany({
          where: { poll_id: { in: pollIds } },
          orderBy: { position: 'asc' },
        })
      : Promise.resolve<poll_options[]>([]),
    pollIds.length
      ? prisma.poll_votes.findMany({ where: { poll_id: { in: pollIds } }, orderBy: { id: 'asc' } })
      : Promise.resolve<poll_votes[]>([]),
    replySourceIds.length
      ? prisma.user_message_files.findMany({
          where: { message_id: { in: replySourceIds } },
          select: { message_id: true },
        })
      : Promise.resolve<{ message_id: number | null }[]>([]),
  ]);

  const optionsByPoll = groupBy(options, (o) => o.poll_id);
  const votesByPoll = groupBy(votes, (v) => v.poll_id);
  const pollsByMessage = new Map<number, PollBundle>();
  for (const p of pollRows) {
    if (pollsByMessage.has(p.message_id)) continue; // .first() в Python — берём один
    pollsByMessage.set(p.message_id, {
      poll: p,
      options: optionsByPoll.get(p.id) ?? [],
      votes: votesByPoll.get(p.id) ?? [],
    });
  }

  // Имена голосовавших нужны только в опросах с открытым списком.
  const voterIds = new Set<number>();
  for (const bundle of pollsByMessage.values()) {
    if (!bundle.poll.show_voters) continue;
    for (const v of bundle.votes) voterIds.add(v.user_id);
  }

  const userIds = new Set<number>([
    ...rows.map((m) => m.sender_id),
    ...replySources.map((m) => m.sender_id),
    ...voterIds,
  ]);
  const userRows: UserRow[] = userIds.size
    ? await prisma.users.findMany({ where: { id: { in: [...userIds] } } })
    : [];
  const userMap = new Map(userRows.map((u) => [u.id, u]));

  // Статус «прочитано» для своих сообщений: отметка ПОЛУЧАТЕЛЯ по диалогу с
  // отправителем. Пары зависят только от сообщений, не от зрителя.
  const readPairs = new Map<string, { user_id: number; peer_key: string }>();
  for (const m of rows) {
    if (m.is_general || m.recipient_id === null) continue;
    const key = `${m.recipient_id}|${m.sender_id}`;
    if (!readPairs.has(key)) {
      readPairs.set(key, { user_id: m.recipient_id, peer_key: String(m.sender_id) });
    }
  }
  const reads = new Map<string, Date | null>();
  if (readPairs.size) {
    const readRows = await prisma.messenger_reads.findMany({
      where: { OR: [...readPairs.values()] },
      orderBy: { id: 'asc' },
    });
    for (const r of readRows) {
      const key = `${r.user_id}|${r.peer_key}`;
      if (!reads.has(key)) reads.set(key, r.last_read_at); // .first() в Python
    }
  }

  const replyFileIds = new Set(
    replyFiles.map((f) => f.message_id).filter((v): v is number => v !== null)
  );
  const replies = new Map<number, ReplyDict>();
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
  rows: { user_id: number; emoji: string }[],
  viewerId: number
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

function reactionsOf(messageId: number, viewerId: number, b: Bundle): ReactionDict[] {
  return aggregateReactions(b.reactions.get(messageId) ?? [], viewerId);
}

/** _reactions_of сразу для нескольких зрителей (флаг «mine» у каждого свой). */
export async function reactionsForViewers(
  messageId: number,
  viewerIds: number[]
): Promise<Map<number, ReactionDict[]>> {
  const rows = await prisma.user_message_reactions.findMany({
    where: { message_id: messageId },
    orderBy: { id: 'asc' },
  });
  return new Map(viewerIds.map((uid) => [uid, aggregateReactions(rows, uid)]));
}

export interface PollDict {
  id: number;
  question: string;
  description: string;
  allow_multiple: boolean;
  show_voters: boolean;
  allow_change: boolean;
  allow_bot: boolean;
  options: {
    id: number;
    text: string;
    votes: number;
    mine: boolean;
    voters: { id: number; name: string; initials: string; sex: string | null; is_bot: boolean }[] | null;
  }[];
  total_votes: number;
  voted: boolean;
}

function pollOf(messageId: number, viewerId: number, b: Bundle): PollDict | null {
  const bundle = b.polls.get(messageId);
  if (!bundle) return null;
  const { poll, options, votes } = bundle;

  const voterIds = new Set(votes.map((v) => v.user_id));
  const byOption = new Map<number, number[]>();
  const mine = new Set<number>();
  for (const v of votes) {
    const bucket = byOption.get(v.option_id);
    if (bucket) bucket.push(v.user_id);
    else byOption.set(v.option_id, [v.user_id]);
    if (v.user_id === viewerId) mine.add(v.option_id);
  }

  return {
    id: poll.id,
    question: poll.question,
    description: poll.description || '',
    allow_multiple: poll.allow_multiple,
    show_voters: poll.show_voters,
    allow_change: poll.allow_change,
    allow_bot: Boolean(poll.allow_bot),
    options: options.map((o) => {
      const uids = byOption.get(o.id) ?? [];
      return {
        id: o.id,
        text: o.text,
        votes: uids.length,
        mine: mine.has(o.id),
        voters: poll.show_voters
          ? uids.map((uid) => {
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
      };
    }),
    total_votes: voterIds.size,
    voted: mine.size > 0,
  };
}

/** Статус доставки СВОЕГО сообщения (для галочек), сравнение по времени. */
function seenStatus(m: MessageRow, b: Bundle): 'seen' | 'delivered' {
  if (m.is_general) return 'delivered';
  const lastReadAt = b.reads.get(`${m.recipient_id}|${m.sender_id}`);
  if (lastReadAt && m.created_at && lastReadAt.getTime() >= m.created_at.getTime()) return 'seen';
  return 'delivered';
}

export interface MessageDict {
  id: number;
  sender_id: number;
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

function renderMessage(m: MessageRow, viewerId: number, b: Bundle): MessageDict {
  const mine = m.sender_id === viewerId;
  // «Заметки» (диалог с самим собой): sender == recipient. По флагу клиент
  // рисует пересланные чужие сообщения слева зелёным пузырём.
  const selfChat = !m.is_general && m.sender_id === m.recipient_id;
  const fm = asDict(m.forwarded_meta);
  const hasMeta = Object.keys(fm).length > 0;
  // «forwarded» (ассистентский пузырёк) — только для снимка ответа ИИ, НЕ для
  // системных строк и НЕ для пересланных сообщений пользователей (from_user).
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
    // created_at хранится наивно в UTC — отдаём с явным UTC-смещением, чтобы
    // клиент разобрал его как UTC (иначе Date() трактует как локальное время).
    created_at: isoUtcTz(m.created_at),
    mine,
    self_chat: selfChat,
    peer_key: peerKeyOf(m, viewerId),
    is_general: m.is_general,
    is_pinned: Boolean(m.is_pinned),
    is_edited: Boolean(m.is_edited),
    is_ai_query: Boolean(m.is_ai_query),
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
  viewerId: number
): Promise<MessageDict[]> {
  if (!rows.length) return [];
  const bundle = await loadBundle(rows);
  return rows.map((m) => renderMessage(m, viewerId, bundle));
}

export async function serializeMessage(m: MessageRow, viewerId: number): Promise<MessageDict> {
  const [dict] = await serializeMessages([m], viewerId);
  return dict;
}

/** Одно сообщение глазами разных получателей (для рассылки события). */
export async function serializeForViewers(
  m: MessageRow,
  viewerIds: number[]
): Promise<Map<number, MessageDict>> {
  const bundle = await loadBundle([m]);
  return new Map(viewerIds.map((uid) => [uid, renderMessage(m, uid, bundle)]));
}

/** _poll_of сразу для нескольких зрителей (свои «mine»/«voted» у каждого). */
export async function pollForViewers(
  m: MessageRow,
  viewerIds: number[]
): Promise<Map<number, PollDict | null>> {
  const bundle = await loadBundle([m]);
  return new Map(viewerIds.map((uid) => [uid, pollOf(m.id, uid, bundle)]));
}

// ── превью для списка диалогов ─────────────────────────────────────────────

/** _preview: текст последнего сообщения диалога. files — вложения сообщения. */
export function previewOf(m: MessageRow, viewerId: number, files: FileRow[]): string {
  const fm = asDict(m.forwarded_meta);
  if (pyBool(fm.system)) return (m.content || '').replace(/\n/g, ' ');

  let base: string;
  if (Object.keys(fm).length && !pyBool(fm.from_user)) {
    base = pyBool(fm.ai) ? 'Ответ ассистента' : '↪ пересланное сообщение ассистента';
  } else {
    // обычное или пересланное от пользователя — текст, а для вложений — метка.
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

// ── непрочитанное и отметки о прочтении ────────────────────────────────────

/** _mark_read: сдвигает отметку прочтения и гасит бейдж у самого читателя. */
export async function markRead(
  userId: number,
  peerKey: string,
  where: Prisma.user_messagesWhereInput
): Promise<void> {
  const agg = await prisma.user_messages.aggregate({ where, _max: { id: true } });
  const maxId = agg._max.id;
  if (maxId === null) return;

  const now = new Date();
  const row = await prisma.messenger_reads.findFirst({
    where: { user_id: userId, peer_key: peerKey },
    orderBy: { id: 'asc' },
  });
  if (!row) {
    await prisma.messenger_reads.create({
      data: { user_id: userId, peer_key: peerKey, last_read_id: maxId, last_read_at: now },
    });
  } else {
    await prisma.messenger_reads.update({
      where: { id: row.id },
      data: {
        last_read_id: maxId > row.last_read_id ? maxId : row.last_read_id,
        last_read_at: now,
      },
    });
  }
  // Событие САМОМУ читателю: бейдж центра уведомлений (в этой и других вкладках)
  // гаснет мгновенно. Собеседнику user_read уходит отдельно.
  publish(userId, { type: 'unread_changed', scope: 'messenger', peer_key: peerKey });
}

/** _do_read: отметка «диалог прочитан» + user_read собеседнику (галочки). */
export async function doRead(
  userId: number,
  peerId: number | null,
  general: boolean
): Promise<void> {
  if (!general && !(await userById(peerId))) return;
  const where = threadWhere(userId, peerId, general);
  await markRead(userId, general ? GENERAL_KEY : pyStr(peerId), where);
  if (!general && peerId) {
    const agg = await prisma.user_messages.aggregate({ where, _max: { id: true } });
    if (agg._max.id) {
      publish(peerId, { type: 'user_read', peer_key: String(userId), last_read_id: agg._max.id });
    }
  }
}

// ── рассылка событий ───────────────────────────────────────────────────────

/**
 * _broadcast: доставка нового сообщения подписчикам SSE плюс системный Web
 * Push получателям (кроме автора) — уведомление приходит, даже если вкладка
 * или приложение закрыты. Порт _broadcast из routes/messenger.py целиком.
 */
export async function broadcastMessage(m: MessageRow): Promise<void> {
  const uids = [...new Set(await recipientsOf(m))];
  const dicts = await serializeForViewers(m, uids);

  // Служебные строки («закрепил(а) сообщение») push не порождают, поэтому и
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

/** Сигнал «печатает» собеседнику(ам). Не сохраняется в БД. */
export async function publishTyping(
  user: CurrentUser,
  peerId: number | null,
  general: boolean,
  isTyping: boolean
): Promise<void> {
  let recipients: number[];
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
      // peer_key с точки зрения получателя: 1-1 → id отправителя, общий → general
      peer_key: general ? GENERAL_KEY : String(user.id),
      sender_id: user.id,
      sender_name: shortName(user),
      sender_initials: initials(user),
      is_general: general,
      typing: Boolean(isTyping),
    });
  }
}

// ── снимок пересылаемого ответа ассистента ─────────────────────────────────

/** _forward_snapshot: текст ответа ИИ + вложение + источники. */
export async function forwardSnapshot(chatMessageId: number): Promise<Record<string, unknown> | null> {
  if (!inInt4(chatMessageId)) return null;
  const cm = await prisma.chat_messages.findUnique({ where: { id: chatMessageId } });
  if (!cm) return null;

  let attachment: { id: number; title: string; filename: string } | null = null;
  let isPii = pyBool(asDict(cm.meta).pii_doc);
  if (cm.attachment_document_id) {
    const doc = await prisma.my_documents.findUnique({ where: { id: cm.attachment_document_id } });
    if (doc) {
      attachment = {
        id: doc.id,
        title: doc.title || 'Документ',
        filename: doc.file_path ? doc.file_path.split('\\').pop()!.split('/').pop()! : '',
      };
      isPii = isPii || Boolean(doc.is_pii);
    }
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

// ── разбор query-параметров в стиле FastAPI ────────────────────────────────

/** `x: Optional[int] = Query(default=None)` — null, если параметра нет. */
export function intQuery(
  raw: string | null,
  name: string
): { value: number | null } | { response: NextResponse } {
  if (raw === null) return { value: null };
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    return {
      response: validationError(
        ['query', name],
        'int_parsing',
        'Input should be a valid integer, unable to parse string as an integer',
        raw
      ),
    };
  }
  return { value: Number.parseInt(raw.trim(), 10) };
}

/** `x: int = Query(...)` — обязательный числовой параметр. */
export function requiredIntQuery(
  raw: string | null,
  name: string
): { value: number } | { response: NextResponse } {
  if (raw === null) {
    return { response: validationError(['query', name], 'missing', 'Field required', null) };
  }
  const parsed = intQuery(raw, name);
  if ('response' in parsed) return parsed;
  return { value: parsed.value as number };
}

// ── разбор тела запроса в стиле FastAPI (Body(...)) ────────────────────────
// FastAPI собирает объявленные Body-параметры в одну модель pydantic и
// возвращает СРАЗУ ВСЕ ошибки списком. Здесь повторены типы ошибок, которые
// встречаются на этих эндпоинтах: missing / int_* / string_type / bool_* / list_type.

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

  /** pydantic-lax int: число без дробной части или числовая строка. */
  private toInt(value: unknown, loc: (string | number)[]): number | null {
    if (typeof value === 'boolean') {
      this.fail(loc, 'int_type', 'Input should be a valid integer', value);
      return null;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        this.fail(loc, 'int_type', 'Input should be a valid integer', value);
        return null;
      }
      if (!Number.isInteger(value)) {
        this.fail(
          loc,
          'int_from_float',
          'Input should be a valid integer, got a number with a fractional part',
          value
        );
        return null;
      }
      return value;
    }
    if (typeof value === 'string') {
      if (!/^\s*[+-]?\d+\s*$/.test(value)) {
        this.fail(
          loc,
          'int_parsing',
          'Input should be a valid integer, unable to parse string as an integer',
          value
        );
        return null;
      }
      return Number.parseInt(value.trim(), 10);
    }
    this.fail(loc, 'int_type', 'Input should be a valid integer', value);
    return null;
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

  /** `x: int = Body(...)` — обязательное целое. */
  int(name: string): number {
    if (!this.has(name)) {
      this.missing(name);
      return 0;
    }
    return this.toInt(this.body[name], ['body', name]) ?? 0;
  }

  /** `x: Optional[int] = Body(default=None)`. */
  optInt(name: string): number | null {
    if (!this.has(name) || this.body[name] === null) return null;
    return this.toInt(this.body[name], ['body', name]);
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

  /** `x: Optional[List[int]] = Body(default=None)`. */
  optIntList(name: string): number[] | null {
    if (!this.has(name) || this.body[name] === null) return null;
    const raw = this.body[name];
    if (!Array.isArray(raw)) {
      this.fail(['body', name], 'list_type', 'Input should be a valid list', raw);
      return null;
    }
    const out: number[] = [];
    raw.forEach((item, i) => {
      const v = this.toInt(item, ['body', name, i]);
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
 * Читает тело как объект Body-параметров. Пустое тело допустимо — FastAPI в
 * этом случае берёт значения по умолчанию (а для обязательных полей выдаст
 * «Field required»).
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

// ── размеры изображений ────────────────────────────────────────────────────

/**
 * Ширина/высота картинки по заголовку файла — замена Pillow (Image.open().size),
 * серверной библиотеки обработки изображений в проекте нет. Размеры нужны, чтобы
 * клиент зарезервировал место под серый плейсхолдер до загрузки.
 *
 * ОТЛИЧИЕ ОТ PYTHON: разбираются png/jpeg/gif/bmp/webp; для остальных форматов
 * (в т.ч. svg — его и Pillow не открывает) отдаём null, как Python при ошибке.
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
    return null; // обрезанный/битый файл — Pillow здесь тоже упал бы
  }
  return null;
}
