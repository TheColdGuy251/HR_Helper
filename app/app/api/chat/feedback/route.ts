import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, forbidden, notFound, requireUser } from '@/lib/auth';
import { jsonBody, pyBool, pyStr } from '@/lib/kb';

// Оценка ответа ассистента (✓ / ✗ / отмена). Порт POST /api/chat/feedback.

/** Python `isinstance(x, int)`: bool — тоже int (True == 1, False == 0). */
function asPyInt(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const parsed = await jsonBody(request);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;

  const msgId = asPyInt(body.message_id);
  if (msgId === null) return badRequest('message_id обязателен');

  const msg = await prisma.chat_messages.findUnique({
    where: { id: msgId },
    select: { id: true, role: true, chat_sessions: { select: { dialogues: { select: { user_id: true } } } } },
  });
  if (!msg || msg.role !== 'assistant') return notFound('Сообщение не найдено');
  // Проверка владельца через сессию диалога.
  if (msg.chat_sessions.dialogues.user_id !== user.id) return forbidden('Нет доступа к сообщению');

  const existing = await prisma.chat_feedback.findFirst({
    where: { message_id: msgId, user_id: user.id },
    select: { id: true },
  });

  const rating = asPyInt(body.rating);
  // `rating in (0, None)` — отмена оценки: удаляем запись.
  if (rating === 0 || body.rating === null || body.rating === undefined) {
    if (existing) await prisma.chat_feedback.delete({ where: { id: existing.id } });
    return NextResponse.json({ success: true, rating: 0 });
  }
  if (rating !== 1 && rating !== -1) return badRequest('rating должен быть 1, -1 или 0');

  // Python: `body.get("comment") or None` — пустая строка тоже даёт NULL.
  const comment = pyBool(body.comment) ? pyStr(body.comment) : null;

  if (existing) {
    await prisma.chat_feedback.update({
      where: { id: existing.id },
      data: { rating, comment },
    });
  } else {
    await prisma.chat_feedback.create({
      data: { message_id: msgId, user_id: user.id, rating, comment },
    });
  }
  return NextResponse.json({ success: true, rating });
}
