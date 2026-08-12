import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';

// Порт POST /api/notifications/{notification_id}/read
// (backend/routes/notifications.py).

/** Python int() принимает знак и пробелы по краям; повторяем его строгость. */
function parseIntParam(raw: string): number | null {
  return /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : null;
}

/** FastAPI отвечает 422 на нечисловой path-параметр — повторяем форму тела. */
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

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const notificationId = parseIntParam(id);
  if (notificationId === null) return invalidIntPath('notification_id', id);

  const note = await prisma.notifications.findUnique({
    where: { id: notificationId },
    select: { id: true },
  });
  if (!note) return notFound('Уведомление не найдено');

  // Вместо «прочитали-и-вставили» полагаемся на уникальный индекс
  // uq_notification_read: повторный клик просто ничего не меняет.
  await prisma.notification_reads.createMany({
    data: [{ notification_id: notificationId, user_id: user.id }],
    skipDuplicates: true,
  });

  return NextResponse.json({ success: true });
}
