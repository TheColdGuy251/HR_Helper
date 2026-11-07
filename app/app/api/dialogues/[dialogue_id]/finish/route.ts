import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { asUuid } from '@/lib/ids';

// Пометить диалог решённым.

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ dialogue_id: string }> }
) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const { dialogue_id } = await params;
  const id = asUuid(dialogue_id);
  // Чужой или несуществующий диалог отдаём как 404, а не 403.
  if (id === null) return notFound('Диалог не найден');
  const d = await prisma.dialogues.findUnique({ where: { id }, select: { user_id: true } });
  if (!d || d.user_id !== user.id) return notFound('Диалог не найден');

  await prisma.dialogues.update({
    where: { id },
    data: { is_finished: true, last_activity: new Date() },
  });
  return NextResponse.json({ success: true });
}
