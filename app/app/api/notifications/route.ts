import { NextResponse } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { fullName, initials, requireUser, shortName } from '@/lib/auth';

// Центр уведомлений (колокольчик в шапке): три источника.
// Порт GET /api/notifications из backend/routes/notifications.py.
//
// - messenger — диалоги мессенджера с непрочитанными сообщениями от людей;
// - ai        — диалоги с непрочитанными ответами ИИ-ассистента;
// - system    — постоянные уведомления (прочтение гасит бейдж, запись остаётся).

const GENERAL_KEY = 'general';

/**
 * forwarded_meta как объект. В Python пустой dict ложен (`bool({}) is False`),
 * поэтому пустую мету трактуем как «меты нет» — иначе разъедутся флаги
 * `forwarded` и ветка `_preview`.
 */
function metaObj(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj).length ? obj : null;
}

/** Служебная строка мессенджера («закрепил(а) сообщение») — не уведомление. */
function isSystemRow(meta: unknown): boolean {
  return Boolean(metaObj(meta)?.system);
}

/** Текст-превью сообщения мессенджера (_preview из Python). */
function previewOf(m: { content: string; forwarded_meta: unknown }): string {
  const fm = metaObj(m.forwarded_meta);
  if (fm && !fm.from_user) {
    return fm.ai ? 'Ответ ассистента' : '↪ пересланное сообщение';
  }
  return (m.content || '📎 вложение').slice(0, 80);
}

interface MessengerItem {
  peer_key: string;
  is_general: boolean;
  peer_id?: number;
  name: string;
  short_name?: string;
  initials: string;
  unread: number;
  preview: string;
  at: string | null;
}

interface AiItem {
  dialogue_id: number;
  title: string;
  session_id: string;
  unread: number;
  preview: string;
  at: string | null;
}

async function messengerItems(userId: number): Promise<MessengerItem[]> {
  const reads = await prisma.messenger_reads.findMany({
    where: { user_id: userId },
    select: { peer_key: true, last_read_id: true },
  });
  // Дубли peer_key перекрываются последней строкой — как dict comprehension.
  const readMap = new Map<string, number>();
  for (const r of reads) readMap.set(r.peer_key, r.last_read_id);

  const items: MessengerItem[] = [];

  // Общий чат. Лимит 500 применяется ДО отсева системных строк — как в Python.
  const lastRead = readMap.get(GENERAL_KEY) ?? 0;
  const generalRows = await prisma.user_messages.findMany({
    where: { is_general: true, sender_id: { not: userId }, id: { gt: lastRead } },
    orderBy: { id: 'desc' },
    take: 500,
  });
  const generalMsgs = generalRows.filter((m) => !isSystemRow(m.forwarded_meta));
  if (generalMsgs.length) {
    const last = generalMsgs[0];
    items.push({
      peer_key: GENERAL_KEY,
      is_general: true,
      name: 'Общий чат',
      initials: '★',
      unread: generalMsgs.length,
      preview: previewOf(last),
      at: isoUtc(last.created_at),
    });
  }

  // Личные диалоги: входящие непрочитанные, группировка по отправителю.
  const rows = await prisma.user_messages.findMany({
    where: { is_general: false, recipient_id: userId },
    orderBy: { id: 'desc' },
    take: 2000,
  });
  const bySender = new Map<number, typeof rows>();
  for (const m of rows) {
    if (m.id > (readMap.get(String(m.sender_id)) ?? 0) && !isSystemRow(m.forwarded_meta)) {
      const bucket = bySender.get(m.sender_id);
      if (bucket) bucket.push(m);
      else bySender.set(m.sender_id, [m]);
    }
  }

  // Python дёргает db.get(User, ...) на каждого отправителя; здесь один запрос
  // вместо N — результат тот же, но без лишних round-trip'ов.
  const senderIds = [...bySender.keys()];
  const senders = senderIds.length
    ? await prisma.users.findMany({ where: { id: { in: senderIds } } })
    : [];
  const senderMap = new Map(senders.map((u) => [u.id, u]));

  for (const [senderId, msgs] of bySender) {
    const u = senderMap.get(senderId);
    const last = msgs[0]; // rows отсортированы по убыванию id
    items.push({
      peer_key: String(senderId),
      is_general: false,
      peer_id: senderId,
      name: u ? fullName(u) : 'Сотрудник',
      short_name: u ? shortName(u) : '—',
      initials: u ? initials(u) : '?',
      unread: msgs.length,
      preview: previewOf(last),
      at: isoUtc(last.created_at),
    });
  }

  // Сортировка по строке даты (как в Python) — стабильная, порядок равных
  // элементов сохраняется.
  items.sort((a, b) => {
    const av = a.at ?? '';
    const bv = b.at ?? '';
    return av < bv ? 1 : av > bv ? -1 : 0;
  });
  return items;
}

async function aiItems(userId: number): Promise<AiItem[]> {
  const rows = await prisma.chat_messages.findMany({
    where: {
      role: 'assistant',
      is_read: false,
      is_finished: true,
      chat_sessions: { dialogues: { user_id: userId } },
    },
    orderBy: { id: 'desc' },
    select: {
      session_id: true,
      content: true,
      created_at: true,
      finished_at: true,
      chat_sessions: {
        select: { dialogue_id: true, dialogues: { select: { title: true } } },
      },
    },
  });

  // Первое (самое свежее по id) сообщение задаёт превью и время диалога.
  const byDialogue = new Map<number, AiItem>();
  for (const m of rows) {
    const dialogueId = m.chat_sessions.dialogue_id;
    let slot = byDialogue.get(dialogueId);
    if (!slot) {
      slot = {
        dialogue_id: dialogueId,
        title: m.chat_sessions.dialogues.title || 'Диалог',
        session_id: m.session_id,
        unread: 0,
        preview: (m.content || '').replace(/\n/g, ' ').slice(0, 80),
        at: isoUtc(m.finished_at ?? m.created_at),
      };
      byDialogue.set(dialogueId, slot);
    }
    slot.unread += 1;
  }
  return [...byDialogue.values()];
}

async function systemItems(userId: number) {
  // Широковещательные (user_id=NULL) + адресные этому пользователю.
  const notes = await prisma.notifications.findMany({
    where: { OR: [{ user_id: null }, { user_id: userId }] },
    orderBy: { id: 'desc' },
    take: 50,
  });
  const reads = await prisma.notification_reads.findMany({
    where: { user_id: userId },
    select: { notification_id: true },
  });
  const readIds = new Set(reads.map((r) => r.notification_id));

  const items = notes.map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    document_id: n.document_id,
    at: isoUtc(n.created_at),
    is_read: readIds.has(n.id),
    diff_url:
      n.kind === 'web_update' && n.document_id
        ? `/kb/documents/${n.document_id}/view?diff=${n.id}`
        : // А7 (doc_expired/doc_stale): клик открывает сам документ
          n.document_id
          ? `/kb/documents/${n.document_id}/view`
          : null,
  }));
  const unread = items.filter((i) => !i.is_read).length;
  return { items, unread };
}

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const messenger = await messengerItems(user.id);
  const ai = await aiItems(user.id);
  const system = await systemItems(user.id);

  return NextResponse.json({
    success: true,
    messenger,
    ai,
    system: system.items,
    counts: {
      messenger: messenger.reduce((sum, i) => sum + i.unread, 0),
      ai: ai.reduce((sum, i) => sum + i.unread, 0),
      system: system.unread,
    },
  });
}
