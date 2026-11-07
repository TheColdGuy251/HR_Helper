import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { isOnline, lastSeenOf } from '@/lib/events';
import { requiredIdQuery } from '@/lib/messenger';

// Онлайн-статус собеседника.
//
// "Онлайн" - есть ли у пользователя открытый SSE-поток (lib/events).
//
// Момент "был(а) в сети" берём из памяти процесса, а если её нет (перезапуск,
// пользователь ещё ни разу не подключался в этом процессе) - последнюю
// активность из БД: позднейшее из "отправил сообщение" и "отметил прочтение".
async function lastSeenFromDb(peerId: string): Promise<Date | null> {
  const [message, read] = await Promise.all([
    prisma.user_messages.aggregate({
      where: { sender_id: peerId },
      _max: { created_at: true },
    }),
    prisma.messenger_reads.aggregate({
      where: { user_id: peerId },
      _max: { last_read_at: true },
    }),
  ]);
  const candidates = [message._max.created_at, read._max.last_read_at].filter(
    (d): d is Date => d instanceof Date
  );
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const peer = requiredIdQuery(request.nextUrl.searchParams.get('peer_id'), 'peer_id');
  if ('response' in peer) return peer.response;
  const peerId = peer.value;

  const online = isOnline(peerId);
  const lastSeen = lastSeenOf(peerId) ?? (await lastSeenFromDb(peerId));

  return NextResponse.json({ online, last_seen: isoUtc(lastSeen) });
}
