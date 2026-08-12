import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { badRequest, notFound, requireAdmin, shortName } from '@/lib/auth';

// Переписка пользователя с конкретным собеседником (или общий чат).
// Порт GET /api/admin/users/{uid}/messenger/{peer_key} (backend/routes/admin.py).

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

/**
 * forwarded_meta как объект. Пустой dict в Python ложен (`bool({}) is False`),
 * поэтому пустую мету считаем отсутствующей — от этого зависит флаг forwarded.
 */
function metaObj(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj).length ? obj : null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ uid: string; peer_key: string }> }
) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { uid, peer_key: peerKey } = await params;
  const userId = parseIntParam(uid);
  if (userId === null) return invalidIntPath('uid', uid);

  const owner = await prisma.users.findUnique({ where: { id: userId }, select: { id: true } });
  if (!owner) return notFound('Пользователь не найден');

  // peer_key — либо числовой id собеседника, либо «general» (общий чат).
  let where: { is_general: boolean; OR?: { sender_id: number; recipient_id: number }[] };
  if (peerKey === 'general') {
    where = { is_general: true };
  } else {
    const peer = parseIntParam(peerKey);
    if (peer === null) return badRequest('Некорректный собеседник');
    where = {
      is_general: false,
      OR: [
        { sender_id: userId, recipient_id: peer },
        { sender_id: peer, recipient_id: userId },
      ],
    };
  }

  const rows = await prisma.user_messages.findMany({
    where,
    orderBy: { created_at: 'asc' },
    take: 1000,
  });

  const senderIds = [...new Set(rows.map((m) => m.sender_id))];
  const senders = senderIds.length
    ? await prisma.users.findMany({ where: { id: { in: senderIds } } })
    : [];
  const senderMap = new Map(senders.map((u) => [u.id, u]));

  // Вложения: имена файлов по id сообщения (порядок — как вернёт БД).
  const msgIds = rows.map((m) => m.id);
  const fileMap = new Map<number, string[]>();
  if (msgIds.length) {
    const files = await prisma.user_message_files.findMany({
      where: { message_id: { in: msgIds } },
      select: { message_id: true, original_name: true },
    });
    for (const f of files) {
      if (f.message_id === null) continue;
      const bucket = fileMap.get(f.message_id);
      if (bucket) bucket.push(f.original_name);
      else fileMap.set(f.message_id, [f.original_name]);
    }
  }

  const items: {
    id: number;
    sender_id: number;
    sender_name: string;
    is_target: boolean;
    content: string;
    forwarded: boolean;
    attachments: string[];
    created_at: string | null;
  }[] = [];
  for (const m of rows) {
    // Служебные строки («закрепил(а)/открепил(а) сообщение») не показываем —
    // это не часть переписки (иначе выглядят как «диалог с собой»).
    const meta = metaObj(m.forwarded_meta);
    if (meta?.system) continue;
    const u = senderMap.get(m.sender_id);
    items.push({
      id: m.id,
      sender_id: m.sender_id,
      sender_name: u ? shortName(u) : `#${m.sender_id}`,
      is_target: m.sender_id === userId,
      content: m.content || '',
      forwarded: Boolean(meta) && !meta?.system,
      attachments: fileMap.get(m.id) ?? [],
      created_at: isoUtc(m.created_at),
    });
  }

  return NextResponse.json({ success: true, items });
}
