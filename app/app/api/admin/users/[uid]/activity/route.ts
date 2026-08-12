import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { notFound, requireAdmin } from '@/lib/auth';

// Активность пользователя: счётчики + последние записи аудита ПДн.
// Порт GET /api/admin/users/{uid}/activity (backend/routes/admin.py).

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

export async function GET(_request: NextRequest, { params }: { params: Promise<{ uid: string }> }) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { uid } = await params;
  const userId = parseIntParam(uid);
  if (userId === null) return invalidIntPath('uid', uid);

  const owner = await prisma.users.findUnique({ where: { id: userId }, select: { id: true } });
  if (!owner) return notFound('Пользователь не найден');

  const [dialoguesCount, sentCount, filesCount, audit] = await Promise.all([
    prisma.dialogues.count({ where: { user_id: userId } }),
    prisma.user_messages.count({ where: { sender_id: userId } }),
    prisma.user_message_files.count({ where: { owner_id: userId } }),
    prisma.pii_audit.findMany({
      where: { user_id: userId },
      orderBy: { id: 'desc' },
      take: 300,
    }),
  ]);

  return NextResponse.json({
    success: true,
    stats: {
      dialogues: dialoguesCount,
      sent_messages: sentCount,
      files: filesCount,
    },
    audit: audit.map((r) => ({
      id: r.id,
      at: isoUtc(r.at),
      action: r.action,
      entity: r.entity,
      entity_id: r.entity_id,
      extra: r.extra,
    })),
  });
}
