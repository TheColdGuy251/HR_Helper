import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireUser } from '@/lib/auth';
import { asDict, asList, boolQuery, pyBool } from '@/lib/kb';
import { publish } from '@/lib/events';
import {
  GENERAL_KEY,
  intQuery,
  markRead,
  serializeMessages,
  threadWhere,
  userById,
} from '@/lib/messenger';

// История диалога с постраничной подгрузкой вверх.
// Порт GET /api/messenger/thread из backend/routes/messenger.py.

// Сразу отдаём последние 100 сообщений, дальше — партиями по 50 (before_id).
const INITIAL_THREAD = 100;
const THREAD_PAGE = 50;

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const query = request.nextUrl.searchParams;
  const peer = intQuery(query.get('peer_id'), 'peer_id');
  if ('response' in peer) return peer.response;
  const general = boolQuery(query.get('general'), 'general');
  if ('response' in general) return general.response;
  const before = intQuery(query.get('before_id'), 'before_id');
  if ('response' in before) return before.response;

  const peerId = peer.value;
  const isGeneral = general.value;
  const beforeId = before.value;

  if (!isGeneral && !peerId) return badRequest('Не указан собеседник');
  if (!isGeneral && !(await userById(peerId))) return notFound('Пользователь не найден');

  const where = threadWhere(me, peerId, isGeneral);
  const rows = (
    await prisma.user_messages.findMany({
      where: beforeId ? { AND: [where, { id: { lt: beforeId } }] } : where,
      orderBy: { id: 'desc' },
      take: beforeId ? THREAD_PAGE : INITIAL_THREAD,
    })
  ).reverse(); // по возрастанию id

  // «удалённые только у себя» — скрываем от этого пользователя
  const msgs = rows.filter((m) => !asList(m.hidden_for).includes(me));

  // Есть ли ещё более старые сообщения (для подгрузки).
  let hasMore = false;
  if (rows.length) {
    const older = await prisma.user_messages.findFirst({
      where: { AND: [where, { id: { lt: rows[0].id } }] },
      select: { id: true },
    });
    hasMore = older !== null;
  }

  const peerKey = isGeneral ? GENERAL_KEY : String(peerId);

  // Граница «новых» сообщений: первое чужое, которое пользователь ещё не читал.
  // Нужна для разделителя «Новые» и бейджа на стрелке вниз.
  let firstUnreadId: number | null = null;
  let unreadCount = 0;
  if (!beforeId) {
    const rr = await prisma.messenger_reads.findFirst({
      where: { user_id: me, peer_key: peerKey },
      orderBy: { id: 'asc' },
    });
    const lastRead = rr?.last_read_id ?? 0;
    const unread = msgs.filter(
      (m) => m.id > lastRead && m.sender_id !== me && !pyBool(asDict(m.forwarded_meta).system)
    );
    if (unread.length) {
      firstUnreadId = unread[0].id;
      unreadCount = unread.length;
    }
  }

  // Отметку о прочтении ставим только при первом открытии, не при подгрузке.
  if (!beforeId) {
    await markRead(me, peerKey, where);
    if (!isGeneral && peerId && msgs.length) {
      const maxId = Math.max(...msgs.map((m) => m.id));
      publish(peerId, { type: 'user_read', peer_key: String(me), last_read_id: maxId });
    }
  }

  return NextResponse.json({
    peer_key: peerKey,
    has_more: hasMore,
    first_unread_id: firstUnreadId,
    unread_count: unreadCount,
    messages: await serializeMessages(msgs, me),
  });
}
