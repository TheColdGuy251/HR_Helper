import 'server-only';
import path from 'node:path';
import type { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import type { chat_role } from '@prisma/client';
import { isoUtc, prisma } from './db';
import { notFound } from './auth';
import { asUuid, compareIds } from './ids';
import { uuidError, validationError } from './news';
import { DOCUMENT_KIND_SELECT, documentTemplateKey } from './docs/common';

// Общие помощники чата с ассистентом: сериализация сообщений, ветвление
// вариантов, история для промпта и реестр активных стримов.

// ---------------------------------------------------------------------------
// Диалог из запроса
// ---------------------------------------------------------------------------

/**
 * id диалога текущего пользователя из параметра запроса: 422 - параметра нет
 * или это не UUID, 404 - диалога нет или он чужой (текст один и тот же, чтобы
 * не подсвечивать существование чужих диалогов).
 */
export async function requireOwnDialogue(
  raw: unknown,
  userId: string,
  loc: ['query' | 'body', string]
): Promise<{ id: string } | { response: NextResponse }> {
  if (raw === null || raw === undefined) {
    return { response: validationError(loc, 'missing', 'Field required', null) };
  }
  const id = asUuid(raw);
  if (!id) return { response: uuidError(loc, raw) };
  const dialogue = await prisma.dialogues.findUnique({ where: { id }, select: { user_id: true } });
  if (!dialogue || dialogue.user_id !== userId) return { response: notFound('Диалог не найден') };
  return { id };
}

/** Имя файла из сохранённого пути. Пути пишет Windows-бэкенд - режем оба разделителя. */
function baseName(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || path.basename(p);
}

// ---------------------------------------------------------------------------
// Пересланные из мессенджера сообщения
// ---------------------------------------------------------------------------

interface ForwardItem {
  sent_at?: string | null;
  from_name?: string | null;
  chat?: string | null;
  text?: string | null;
  attachments?: { name?: string | null }[] | null;
}

/** Читаемый блок пересланных сообщений для промпта модели. */
export function formatForwardBlock(items: unknown): string {
  const list = Array.isArray(items) ? (items as ForwardItem[]) : [];
  const lines = ['Пользователь переслал сообщения из корпоративного мессенджера:'];
  list.forEach((it, i) => {
    // Поля метки печатаем как есть, без пересчёта зоны. Поэтому разбираем строку
    // регэкспом, а не через Date: тот привёл бы наивную метку к локальной зоне
    // сервера.
    let when = '';
    const raw = (it?.sent_at || '').replace('Z', '+00:00');
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(raw);
    if (m) when = `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`;
    const who = it?.from_name || '—';
    const head = `${i + 1}. [${it?.chat || 'чат'}] От: ${who}${when ? `, ${when} UTC` : ''}`;
    let text = (it?.text || '').trim() || '(без текста)';
    const atts = (it?.attachments || [])
      .map((a) => a?.name || '')
      .filter(Boolean)
      .join(', ');
    if (atts) text += ` [вложения: ${atts}]`;
    lines.push(`${head}: ${text}`);
  });
  return lines.join('\n');
}

/**
 * Текст запроса к пайплайну для сообщения с пересланным блоком.
 * Без комментария пользователя RAG отключаем: предмет - сами пересланные
 * сообщения, а поиск по ним находит случайные документы.
 */
export function genTextForUserMessage(
  msgText: string,
  fwd: unknown,
  useRag: boolean
): { text: string; useRag: boolean; forwarded: boolean } {
  const hasFwd = Array.isArray(fwd) ? fwd.length > 0 : Boolean(fwd);
  if (!hasFwd) return { text: msgText, useRag, forwarded: false };

  const block = formatForwardBlock(fwd);
  if (msgText) {
    return {
      text: `${block}\n\nВопрос/комментарий пользователя к пересланному: ${msgText}`,
      useRag,
      forwarded: true,
    };
  }
  return {
    text:
      `${block}\n\nПользователь переслал эти сообщения без комментария. ` +
      'Кратко отреагируй по их содержанию: если в них есть вопрос — ответь на него, ' +
      'иначе поясни суть и предложи, чем можешь помочь.',
    useRag: false,
    forwarded: true,
  };
}

// ---------------------------------------------------------------------------
// Ветвление диалога (правки вопросов / ретраи ответов)
// ---------------------------------------------------------------------------

/** Минимум полей сообщения, нужный для расчёта активной ветки. */
export interface BranchMsg {
  id: string;
  role: string;
  variant_group: string | null;
  variant_active: boolean;
  reply_to: string | null;
  branch_of: string | null;
}

/**
 * Сообщения, не принадлежащие активной ветке диалога.
 *
 * Диалог - дерево: правка вопроса или ретрай ответа создаёт вариант, у каждого
 * сообщения есть "якорь" (ответ ассистента - на свой вопрос через reply_to;
 * вопрос - на ответ, после которого он был задан, через branch_of). Скрываем
 * неактивные варианты и - каскадно - всё, что на них навешано.
 */
export function hiddenMessageIds(msgs: BranchMsg[]): Set<string> {
  const groups = new Map<string, BranchMsg[]>();
  const groupKey = (m: BranchMsg) => `${m.role}:${m.variant_group ?? m.id}`;
  for (const m of msgs) {
    const key = groupKey(m);
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }

  const hidden = new Set<string>();
  for (const variants of groups.values()) {
    if (variants.length < 2) continue;
    const act = variants.find((x) => x.variant_active) ?? variants[variants.length - 1];
    for (const v of variants) if (v.id !== act.id) hidden.add(v.id);
  }

  const assistIds = msgs.filter((m) => m.role === 'assistant').map((m) => m.id);

  const anchor = (m: BranchMsg): string | null => {
    if (m.role === 'assistant') return m.reply_to;
    if (m.branch_of) return m.branch_of;
    // Фолбэк без branch_of: ближайший предыдущий ответ. Позицию берём по первому
    // варианту группы - правка позднее создаёт вариант с большим id, но логически
    // он стоит на месте исходного вопроса. UUIDv7 растут со временем.
    const pos = (groups.get(groupKey(m)) as BranchMsg[])[0].id;
    const prev = assistIds.filter((i) => compareIds(i, pos) < 0);
    return prev.length ? prev[prev.length - 1] : null;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const m of msgs) {
      if (hidden.has(m.id)) continue;
      const a = anchor(m);
      if (a && hidden.has(a)) {
        hidden.add(m.id);
        changed = true;
      }
    }
  }
  return hidden;
}

// ---------------------------------------------------------------------------
// Сериализация сообщения для клиента
// ---------------------------------------------------------------------------

type MessageRow = {
  id: string;
  role: chat_role;
  content: string;
  is_read: boolean;
  is_finished: boolean;
  created_at: Date;
  finished_at: Date | null;
  sources: unknown;
  meta: unknown;
  fact_check: unknown;
  forwarded_meta: unknown;
  attachment_document_id: string | null;
  variant_group: string | null;
  variant_active: boolean;
  reply_to: string | null;
  branch_of: string | null;
};

export type MessageItem = Record<string, unknown>;

/**
 * Сериализация сообщений для клиента. Связанные данные подтягиваются пачкой, а
 * не запросами на каждое сообщение.
 */
export async function messageItems(rows: MessageRow[]): Promise<MessageItem[]> {
  const docIds = [...new Set(rows.map((m) => m.attachment_document_id).filter((v): v is string => v != null))];
  const userIds = rows.filter((m) => m.role === 'user').map((m) => m.id);
  const asstIds = rows.filter((m) => m.role === 'assistant').map((m) => m.id);

  const [docs, uploads, feedback] = await Promise.all([
    docIds.length
      ? prisma.my_documents.findMany({
          where: { id: { in: docIds } },
          select: { id: true, title: true, file_path: true, ...DOCUMENT_KIND_SELECT },
        })
      : Promise.resolve([]),
    userIds.length
      ? prisma.chat_attachments.findMany({
          where: { message_id: { in: userIds } },
          orderBy: { id: 'asc' },
          select: { id: true, filename: true, message_id: true },
        })
      : Promise.resolve([]),
    // Оценку ставит владелец диалога - она одна на сообщение.
    asstIds.length
      ? prisma.chat_feedback.findMany({
          where: { message_id: { in: asstIds } },
          select: { message_id: true, rating: true },
        })
      : Promise.resolve([]),
  ]);

  const docById = new Map(docs.map((d) => [d.id, d]));
  const uploadsByMsg = new Map<string, { id: string; filename: string }[]>();
  for (const u of uploads) {
    if (u.message_id == null) continue;
    const list = uploadsByMsg.get(u.message_id);
    if (list) list.push(u);
    else uploadsByMsg.set(u.message_id, [u]);
  }
  const ratingByMsg = new Map(feedback.map((f) => [f.message_id, f.rating]));

  return rows.map((m) => {
    const item: MessageItem = {
      id: m.id,
      role: m.role,
      content: m.content,
      is_read: m.is_read,
      is_finished: m.is_finished,
      created_at: isoUtc(m.created_at),
      finished_at: isoUtc(m.finished_at),
      // Время для показа: у ассистента - конец генерации, у пользователя - отправка.
      ts: m.role === 'assistant' ? isoUtc(m.finished_at ?? m.created_at) : isoUtc(m.created_at),
      sources: m.sources ?? null,
      meta: m.role === 'assistant' ? m.meta ?? null : null,
      fact_check: m.role === 'assistant' ? m.fact_check ?? null : null,
      forwarded: m.role === 'user' && m.forwarded_meta ? m.forwarded_meta : null,
    };

    if (m.attachment_document_id) {
      const doc = docById.get(m.attachment_document_id);
      if (doc) {
        item.attachment = {
          id: doc.id,
          title: doc.title,
          filename: baseName(doc.file_path),
          template_key: documentTemplateKey(doc),
        };
      }
    }
    if (m.role === 'user') {
      const ups = uploadsByMsg.get(m.id);
      if (ups?.length) item.user_attachments = ups.map((u) => ({ id: u.id, name: u.filename }));
    }
    if (m.role === 'assistant') {
      item.user_rating = ratingByMsg.get(m.id) ?? 0;
    }
    return item;
  });
}

/** Поля, которые читает messageItems/hiddenMessageIds - один select на всех. */
export const MESSAGE_SELECT = {
  id: true,
  role: true,
  content: true,
  is_read: true,
  is_finished: true,
  created_at: true,
  finished_at: true,
  sources: true,
  meta: true,
  fact_check: true,
  forwarded_meta: true,
  attachment_document_id: true,
  variant_group: true,
  variant_active: true,
  reply_to: true,
  branch_of: true,
} as const;

// ---------------------------------------------------------------------------
// История для промпта
// ---------------------------------------------------------------------------

/** Текст сообщения для истории модели: пересланный блок + собственный текст. */
export function historyEntryContent(m: {
  role: string;
  content: string;
  forwarded_meta: unknown;
}): string {
  if (m.role === 'user' && m.forwarded_meta) {
    const block = formatForwardBlock(m.forwarded_meta);
    return m.content ? `${block}\n\n${m.content}` : block;
  }
  return m.content;
}

/** Сколько последних пар реплик держать "как есть". */
export const MEMORY_RECENT_KEEP = Math.max(1, Number(process.env.RAG_MEMORY_RECENT_KEEP || 2));

/**
 * История сообщений до указанного. Берём только активные варианты ассистента,
 * чтобы не смешивать ветки.
 */
export async function collectHistoryBefore(
  dialogueId: string,
  beforeId: string,
  limit = MEMORY_RECENT_KEEP
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const rows = await prisma.chat_messages.findMany({
    where: {
      dialogue_id: dialogueId,
      is_finished: true,
      id: { lt: beforeId },
    },
    orderBy: { id: 'desc' },
    take: limit * 2,
    select: { role: true, content: true, forwarded_meta: true, variant_active: true },
  });

  return rows
    .reverse()
    .filter((m) => m.role === 'user' || m.variant_active)
    .map((m) => ({
      role: m.role,
      content: historyEntryContent(m),
    }));
}

// ---------------------------------------------------------------------------
// Завершение генерации
// ---------------------------------------------------------------------------

/**
 * Пишет текущий текст в БД, при необходимости
 * привязывает готовый документ и будит SSE.
 *
 * Живёт здесь (а не в lib/chat-generate.ts), потому что этим финишем
 * пользуются и ветки инструментов/докгена (lib/docs/chat-tools.ts,
 * lib/docs/docgen.ts) - иначе получился бы цикл импортов.
 */
export async function persistAndFinish(
  assistantMessageId: string,
  state: StreamState,
  meta: Record<string, unknown> | null = null,
  attachDocId: string | null = null
): Promise<void> {
  try {
    let finalMeta = meta;
    if (attachDocId !== null) {
      // ПДн-документ: помечаем ответ И запросное сообщение пользователя
      // (вместе с его вложениями-выгрузками) для автоудаления по TTL -
      // по ТЗ содержимое с персональными данными не хранится.
      const doc = await prisma.my_documents.findUnique({
        where: { id: attachDocId },
        select: { is_pii: true },
      });
      if (doc?.is_pii) {
        finalMeta = { ...(meta || {}), pii_doc: true };
        const msg = await prisma.chat_messages.findUnique({
          where: { id: assistantMessageId },
          select: { dialogue_id: true },
        });
        const req = msg
          ? await prisma.chat_messages.findFirst({
              where: { dialogue_id: msg.dialogue_id, role: 'user', id: { lt: assistantMessageId } },
              orderBy: { id: 'desc' },
              select: { id: true, meta: true },
            })
          : null;
        if (req) {
          const prev =
            req.meta && typeof req.meta === 'object' && !Array.isArray(req.meta)
              ? (req.meta as Record<string, unknown>)
              : {};
          await prisma.chat_messages.update({
            where: { id: req.id },
            data: { meta: { ...prev, pii_doc: true } as unknown as Prisma.InputJsonValue },
          });
        }
      }
    }

    await prisma.chat_messages.update({
      where: { id: assistantMessageId },
      data: {
        content: state.content,
        is_finished: true,
        finished_at: new Date(),
        last_seq: state.last_seq,
        ...(attachDocId !== null ? { attachment_document_id: attachDocId } : {}),
        ...(finalMeta ? { meta: finalMeta as unknown as Prisma.InputJsonValue } : {}),
      },
    });
  } catch {
    /* сообщение могли удалить - стрим всё равно закрываем */
  }
  state.finished = true;
  state.event.set();
}

/** Общий финиш инструментальных веток: текст + (опционально) вложение. */
export async function finishTool(
  assistantMessageId: string,
  state: StreamState,
  text: string,
  attachDocId: string | null = null
): Promise<true> {
  state.append(text);
  state.event.set();
  await persistAndFinish(assistantMessageId, state, null, attachDocId);
  return true;
}

// ---------------------------------------------------------------------------
// Реестр активных стримов (в памяти процесса)
// ---------------------------------------------------------------------------

/** Событие-флаг: будит SSE-цикл при появлении данных. */
export class StreamEvent {
  private flag = false;
  private resolvers: (() => void)[] = [];

  set(): void {
    this.flag = true;
    const pending = this.resolvers;
    this.resolvers = [];
    for (const r of pending) r();
  }

  clear(): void {
    this.flag = false;
  }

  /** true - событие пришло, false - истёк таймаут (пора слать keepalive). */
  wait(timeoutMs: number): Promise<boolean> {
    if (this.flag) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const fire = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const i = this.resolvers.indexOf(fire);
        if (i >= 0) this.resolvers.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      this.resolvers.push(fire);
    });
  }
}

export class StreamState {
  dialogue_id: string;
  message_id: string;
  started_at: Date;
  /** Последовательные чанки текста - индекс в массиве и есть seq. */
  buffer: string[] = [];
  finished = false;
  cancelled = false;
  /** queued | search | rerank | generate */
  status = 'search';
  /** Позиция в очереди к ассистенту, пока запрос ждёт (0 - не в очереди). */
  queue_position = 0;
  queue_total = 0;
  /** Структурные источники - готовы до текста. */
  sources: unknown[] = [];
  /** id только что созданного сообщения пользователя (для обычной отправки). */
  user_message_id: string | null = null;
  event = new StreamEvent();

  constructor(dialogueId: string, messageId: string, userMessageId: string | null = null) {
    this.dialogue_id = dialogueId;
    this.message_id = messageId;
    this.started_at = new Date();
    this.user_message_id = userMessageId;
  }

  get content(): string {
    return this.buffer.join('');
  }

  get last_seq(): number {
    return this.buffer.length;
  }

  append(chunk: string): void {
    this.buffer.push(chunk);
  }

  /** Меняет стадию конвейера и будит SSE-цикл. */
  setStatus(stage: string): void {
    this.status = stage;
    this.event.set();
  }
}

const g = globalThis as unknown as {
  __hrStreams?: Map<string, StreamState>;
  __hrStreamsByDialogue?: Map<string, Set<string>>;
};

function registry() {
  if (!g.__hrStreams) g.__hrStreams = new Map();
  if (!g.__hrStreamsByDialogue) g.__hrStreamsByDialogue = new Map();
  return { byId: g.__hrStreams, byDialogue: g.__hrStreamsByDialogue };
}

export function registerStream(state: StreamState): void {
  const { byId, byDialogue } = registry();
  byId.set(state.message_id, state);
  const set = byDialogue.get(state.dialogue_id) ?? new Set<string>();
  set.add(state.message_id);
  byDialogue.set(state.dialogue_id, set);
}

export function unregisterStream(state: StreamState): void {
  const { byId, byDialogue } = registry();
  byId.delete(state.message_id);
  const set = byDialogue.get(state.dialogue_id);
  if (set) {
    set.delete(state.message_id);
    if (!set.size) byDialogue.delete(state.dialogue_id);
  }
}

export function getStream(messageId: string): StreamState | null {
  return registry().byId.get(messageId) ?? null;
}

export function dialogueStreams(dialogueId: string): StreamState[] {
  const { byId, byDialogue } = registry();
  return [...(byDialogue.get(dialogueId) ?? [])]
    .map((id) => byId.get(id))
    .filter((s): s is StreamState => Boolean(s));
}

/**
 * Восстановление после рестарта сервера: реестр стримов и очередь LLM живут
 * в памяти, вместе с процессом умирают и сами генерации (это оборванные
 * HTTP-запросы - их не "доиграть"). Чтобы у пользователя не висело вечное
 * "печатает...", закрываем осиротевшие сообщения ассистента понятной пометкой -
 * кнопка "повторить" создаст новый вариант.
 *
 * Вызывается из instrumentation.ts на старте; активные стримы (появившиеся
 * между стартом и вызовом) не трогаем.
 */
export async function recoverInterruptedStreams(): Promise<number> {
  const { prisma } = await import('@/lib/db');
  const live = [...registry().byId.keys()];
  const orphans = await prisma.chat_messages.findMany({
    where: {
      role: 'assistant',
      is_finished: false,
      ...(live.length ? { id: { notIn: live } } : {}),
      // Свежесозданные (< 10 с) могло ещё не подхватить runGeneration.
      created_at: { lt: new Date(Date.now() - 10_000) },
    },
    select: { id: true, content: true },
  });
  const note =
    '⚠️ Генерация была прервана перезапуском сервера. ' +
    'Отправьте вопрос ещё раз или нажмите «повторить».';
  for (const m of orphans) {
    await prisma.chat_messages
      .update({
        where: { id: m.id },
        data: {
          content: m.content ? `${m.content}\n\n${note}` : note,
          is_finished: true,
          finished_at: new Date(),
        },
      })
      .catch(() => undefined);
  }
  return orphans.length;
}
