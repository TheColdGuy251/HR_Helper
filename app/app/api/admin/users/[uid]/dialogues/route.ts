import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { notFound, requireAdmin } from '@/lib/auth';
import { parsePathId } from '@/lib/kb';

// Диалоги пользователя с ботом + число сообщений в каждом.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ uid: string }> }) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).uid, 'uid');
  if ('response' in parsed) return parsed.response;
  const userId = parsed.value;

  const owner = await prisma.users.findUnique({ where: { id: userId }, select: { id: true } });
  if (!owner) return notFound('Пользователь не найден');

  // Число сообщений - счётчиком связи, без N+1 (все роли и все варианты ответа).
  const dialogues = await prisma.dialogues.findMany({
    where: { user_id: userId },
    orderBy: { last_activity: 'desc' },
    include: { _count: { select: { messages: true } } },
  });

  const items = dialogues.map((d) => ({
    id: d.id,
    title: d.title || 'Без названия',
    is_finished: d.is_finished,
    last_activity: isoUtc(d.last_activity),
    messages: d._count.messages,
  }));

  return NextResponse.json({ success: true, items });
}
