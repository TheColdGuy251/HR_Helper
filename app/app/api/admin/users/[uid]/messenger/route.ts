import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { fullName, notFound, requireAdmin } from '@/lib/auth';

// Список бесед пользователя в мессенджере (общий чат + личные).
// Порт GET /api/admin/users/{uid}/messenger (backend/routes/admin.py).

function parseIntParam(raw: string): number | null {
  return /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : null;
}

function invalidIntPath(name: string, input: string) {
  return NextResponse.json(
    {
      detail: [
        {
          type: 'int_parsing',
          loc: ['path', name],
          msg: 'Input should be a valid integer, unable to parse string as an integer',
          input,
        },
      ],
    },
    { status: 422 }
  );
}

/** Служебная строка («закрепил(а) сообщение») — не часть переписки. */
function isSystemRow(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return Boolean((meta as Record<string, unknown>).system);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ uid: string }> }) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { uid } = await params;
  const userId = parseIntParam(uid);
  if (userId === null) return invalidIntPath('uid', uid);

  const owner = await prisma.users.findUnique({ where: { id: userId }, select: { id: true } });
  if (!owner) return notFound('Пользователь не найден');

  // Без лимита и без сортировки — ровно как в Python.
  const msgs = await prisma.user_messages.findMany({
    where: { OR: [{ sender_id: userId }, { recipient_id: userId }] },
    select: {
      sender_id: true,
      recipient_id: true,
      is_general: true,
      forwarded_meta: true,
      created_at: true,
    },
  });

  interface Conv {
    peer_id: number | null;
    count: number;
    last_at: Date | null;
  }
  const convs = new Map<string, Conv>();
  for (const m of msgs) {
    if (isSystemRow(m.forwarded_meta)) continue;

    let key: string;
    let peerId: number | null;
    if (m.is_general) {
      key = 'general';
      peerId = null;
    } else {
      peerId = m.sender_id === userId ? m.recipient_id : m.sender_id;
      key = String(peerId);
    }

    let conv = convs.get(key);
    if (!conv) {
      conv = { peer_id: peerId, count: 0, last_at: null };
      convs.set(key, conv);
    }
    conv.count += 1;
    if (conv.last_at === null || (m.created_at && m.created_at > conv.last_at)) {
      conv.last_at = m.created_at;
    }
  }

  // Имена собеседников одним запросом (peer_id=0/null отсеиваются, как `if c["peer_id"]`).
  const peerIds = [...convs.values()]
    .map((c) => c.peer_id)
    .filter((v): v is number => Boolean(v));
  const peers = peerIds.length ? await prisma.users.findMany({ where: { id: { in: peerIds } } }) : [];
  const peerMap = new Map(peers.map((u) => [u.id, u]));

  const items = [...convs.entries()].map(([key, c]) => {
    let title: string;
    if (key === 'general') {
      title = 'Общий чат';
    } else {
      const u = c.peer_id === null ? undefined : peerMap.get(c.peer_id);
      title = u ? fullName(u) : `Пользователь #${c.peer_id}`;
    }
    return { key, title, count: c.count, last_at: isoUtc(c.last_at) };
  });

  // Сортировка по строке даты — как в Python (стабильная).
  items.sort((a, b) => {
    const av = a.last_at ?? '';
    const bv = b.last_at ?? '';
    return av < bv ? 1 : av > bv ? -1 : 0;
  });

  return NextResponse.json({ success: true, items });
}
