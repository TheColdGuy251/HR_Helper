import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { fullName, initials, requireUser, shortName } from '@/lib/auth';
import { asDict, pyBool } from '@/lib/kb';
import {
  GENERAL_KEY,
  previewOf,
  type FileRow,
  type MessageRow,
} from '@/lib/messenger';

// Список диалогов: все активные пользователи + общий чат + «Заметки».
// Порт GET /api/messenger/conversations из backend/routes/messenger.py.
//
// Python на каждого собеседника делает 3 запроса (последнее сообщение, отметка
// прочтения, непрочитанные). Здесь всё считается пакетно — ответ идентичен.

interface ConvItem {
  key: string;
  peer_id: number | null;
  name: string;
  short_name: string;
  initials: string;
  position: string;
  is_notes?: boolean;
  unread: number;
  last_text: string;
  last_at: string | null;
}

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const term = (request.nextUrl.searchParams.get('q') || '').trim().toLowerCase();

  const users = await prisma.users.findMany({
    where: { id: { not: me }, is_active: true },
    orderBy: [{ surname: 'asc' }, { name: 'asc' }],
  });
  const peers = term
    ? users.filter(
        (u) =>
          fullName(u).toLowerCase().includes(term) || (u.username || '').toLowerCase().includes(term)
      )
    : users;

  // ── лёгкий снимок сообщений: только id/автор/собеседник ──────────────────
  const [directRows, generalRows, readRows] = await Promise.all([
    prisma.user_messages.findMany({
      where: { is_general: false, OR: [{ sender_id: me }, { recipient_id: me }] },
      select: { id: true, sender_id: true, recipient_id: true },
      orderBy: { id: 'desc' },
    }),
    prisma.user_messages.findMany({
      where: { is_general: true },
      select: { id: true, sender_id: true },
      orderBy: { id: 'desc' },
    }),
    prisma.messenger_reads.findMany({ where: { user_id: me }, orderBy: { id: 'asc' } }),
  ]);

  // Отметка прочтения по ключу диалога (Python берёт .first()).
  const lastReadBy = new Map<string, number>();
  for (const r of readRows) {
    if (!lastReadBy.has(r.peer_key)) lastReadBy.set(r.peer_key, r.last_read_id);
  }

  // Последнее сообщение и непрочитанные — за один проход по снимку (он уже
  // отсортирован по убыванию id, поэтому первое попадание и есть последнее).
  const lastIdBy = new Map<string, number>();
  const unreadCandidates = new Map<string, number[]>();
  const remember = (key: string, msgId: number, senderId: number) => {
    if (!lastIdBy.has(key)) lastIdBy.set(key, msgId);
    if (senderId === me) return;
    if (msgId <= (lastReadBy.get(key) ?? 0)) return;
    const bucket = unreadCandidates.get(key);
    if (bucket) bucket.push(msgId);
    else unreadCandidates.set(key, [msgId]);
  };
  for (const m of directRows) {
    const peer = m.sender_id === me ? m.recipient_id : m.sender_id;
    if (peer === null) continue;
    remember(String(peer), m.id, m.sender_id);
  }
  for (const m of generalRows) remember(GENERAL_KEY, m.id, m.sender_id);

  // Системные строки («закрепил(а) сообщение») непрочитанными не считаются —
  // мету тянем только по кандидатам, их всегда немного.
  const candidateIds = [...unreadCandidates.values()].flat();
  const systemIds = new Set<number>();
  if (candidateIds.length) {
    const rows = await prisma.user_messages.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, forwarded_meta: true },
    });
    for (const r of rows) {
      if (pyBool(asDict(r.forwarded_meta).system)) systemIds.add(r.id);
    }
  }
  const unreadOf = (key: string): number =>
    (unreadCandidates.get(key) ?? []).filter((id) => !systemIds.has(id)).length;

  // ── последние сообщения целиком (для превью) ─────────────────────────────
  const lastIds = [...new Set(lastIdBy.values())];
  const lastById = new Map<number, MessageRow>();
  const filesByMessage = new Map<number, FileRow[]>();
  if (lastIds.length) {
    const [rows, files] = await Promise.all([
      prisma.user_messages.findMany({ where: { id: { in: lastIds } } }),
      prisma.user_message_files.findMany({
        where: { message_id: { in: lastIds } },
        orderBy: { id: 'asc' },
      }),
    ]);
    for (const r of rows) lastById.set(r.id, r);
    for (const f of files) {
      if (f.message_id === null) continue;
      const bucket = filesByMessage.get(f.message_id);
      if (bucket) bucket.push(f);
      else filesByMessage.set(f.message_id, [f]);
    }
  }
  const lastOf = (key: string): MessageRow | null => {
    const id = lastIdBy.get(key);
    return id === undefined ? null : (lastById.get(id) ?? null);
  };
  const previewFor = (m: MessageRow | null): { text: string; at: string | null } =>
    m
      ? { text: previewOf(m, me, filesByMessage.get(m.id) ?? []), at: isoUtc(m.created_at) }
      : { text: '', at: null };

  const items: ConvItem[] = peers.map((u) => {
    const last = previewFor(lastOf(String(u.id)));
    return {
      key: String(u.id),
      peer_id: u.id,
      name: fullName(u),
      short_name: shortName(u),
      initials: initials(u),
      position: u.position || '',
      unread: unreadOf(String(u.id)),
      last_text: last.text,
      last_at: last.at,
    };
  });

  // Общий чат — показываем всегда первым, если поиск пуст или совпадает.
  let general: ConvItem | null = null;
  if (!term || 'общий чат общий'.includes(term)) {
    const last = previewFor(lastOf(GENERAL_KEY));
    general = {
      key: GENERAL_KEY,
      peer_id: null,
      name: 'Общий чат',
      short_name: 'Общий чат',
      initials: '★',
      position: 'Все сотрудники',
      unread: unreadOf(GENERAL_KEY),
      last_text: last.text,
      last_at: last.at,
    };
  }

  // «Заметки» — личный self-чат (sender == recipient == user.id).
  let notes: ConvItem | null = null;
  if (!term || 'заметки notes мои заметки'.includes(term)) {
    const last = previewFor(lastOf(String(me)));
    notes = {
      key: String(me),
      peer_id: me,
      name: 'Заметки',
      short_name: 'Заметки',
      initials: '📝',
      position: 'Личные заметки и запросы к ИИ',
      is_notes: true,
      unread: 0, // свои заметки непрочитанными не бывают
      last_text: last.text,
      last_at: last.at,
    };
  }

  return NextResponse.json({ general, notes, users: items });
}
