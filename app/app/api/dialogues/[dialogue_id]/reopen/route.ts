import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';

// Вернуть диалог в активные.
// Порт POST /api/dialogues/{dialogue_id}/reopen из backend/routes/dialogues.py.

/** FastAPI объявляет dialogue_id как int; всё, что не влезает в int4, — заведомо не найдено. */
function parseId(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ dialogue_id: string }> }
) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const { dialogue_id } = await params;
  const id = parseId(dialogue_id);
  // Чужой диалог отдаём как 404, а не 403 — ровно как Python.
  if (id === null) return notFound('Диалог не найден');
  const d = await prisma.dialogues.findUnique({ where: { id }, select: { user_id: true } });
  if (!d || d.user_id !== user.id) return notFound('Диалог не найден');

  // last_activity бампаем сами: в SQLAlchemy это делает onupdate=current_timestamp.
  await prisma.dialogues.update({
    where: { id },
    data: { is_finished: false, last_activity: new Date() },
  });
  return NextResponse.json({ success: true });
}
