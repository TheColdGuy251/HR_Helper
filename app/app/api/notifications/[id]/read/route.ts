import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { parsePathId } from '@/lib/kb';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const parsed = parsePathId((await params).id, 'notification_id');
  if ('response' in parsed) return parsed.response;
  const notificationId = parsed.value;

  const note = await prisma.notifications.findUnique({
    where: { id: notificationId },
    select: { id: true },
  });
  if (!note) return notFound('Уведомление не найдено');

  // Вместо "прочитали-и-вставили" полагаемся на составной ключ
  // (notification_id, user_id): повторный клик просто ничего не меняет.
  await prisma.notification_reads.createMany({
    data: [{ notification_id: notificationId, user_id: user.id }],
    skipDuplicates: true,
  });

  return NextResponse.json({ success: true });
}
