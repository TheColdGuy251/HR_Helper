import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { isOnline, isoUtcTz, lastSeenOf } from '@/lib/events';
import { requiredIntQuery } from '@/lib/messenger';

// Онлайн-статус собеседника.
// Порт GET /api/messenger/presence из backend/routes/messenger.py.
//
// «Онлайн» — есть ли у пользователя открытый SSE-поток (lib/events), ровно как
// в Python (notify.is_online).
//
// ОТЛИЧИЕ ОТ PYTHON: момент «был(а) в сети» Python берёт ТОЛЬКО из памяти
// процесса, поэтому после перезапуска сервера он пропадает («не в сети» без
// даты). Здесь память — приоритетный источник, а если её нет (перезапуск,
// пользователь ещё ни разу не подключался в этом процессе), берём последнюю
// активность из БД: позднейшее из «отправил сообщение» и «отметил прочтение».
async function lastSeenFromDb(peerId: number): Promise<Date | null> {
  // id вне int4 в БД не существует — Prisma на таком значении бросила бы ошибку,
  // а Python просто отдал бы «нет данных».
  if (!Number.isInteger(peerId) || peerId < -2147483648 || peerId > 2147483647) return null;
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

  const peer = requiredIntQuery(request.nextUrl.searchParams.get('peer_id'), 'peer_id');
  if ('response' in peer) return peer.response;
  const peerId = peer.value;

  const online = isOnline(peerId);
  const lastSeen = lastSeenOf(peerId) ?? (await lastSeenFromDb(peerId));

  return NextResponse.json({ online, last_seen: isoUtcTz(lastSeen) });
}
