import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, forbidden, notFound, requireUser } from '@/lib/auth';
import { asUuid } from '@/lib/ids';
import { jsonBody, pyBool, pyStr } from '@/lib/kb';

// Оценка ответа ассистента: "нравится", "не нравится" или отмена оценки.
// Оценку ставит владелец диалога - одна на сообщение (chat_feedback.message_id - ключ).

/** Целое из тела запроса; true/false считаются как 1/0. */
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

  const msgId = asUuid(body.message_id);
  if (msgId === null) return badRequest('message_id обязателен');

  const msg = await prisma.chat_messages.findUnique({
    where: { id: msgId },
    select: { id: true, role: true, dialogue: { select: { user_id: true } } },
  });
  if (!msg || msg.role !== 'assistant') return notFound('Сообщение не найдено');
  // Проверка владельца через диалог.
  if (msg.dialogue.user_id !== user.id) return forbidden('Нет доступа к сообщению');

  const rating = asPyInt(body.rating);
  // rating 0 или null - отмена оценки: удаляем запись.
  if (rating === 0 || body.rating === null || body.rating === undefined) {
    await prisma.chat_feedback.deleteMany({ where: { message_id: msgId } });
    return NextResponse.json({ success: true, rating: 0 });
  }
  if (rating !== 1 && rating !== -1) return badRequest('rating должен быть 1, -1 или 0');

  // Пустой комментарий сохраняем как NULL.
  const comment = pyBool(body.comment) ? pyStr(body.comment) : null;

  await prisma.chat_feedback.upsert({
    where: { message_id: msgId },
    create: { message_id: msgId, rating, comment },
    update: { rating, comment },
  });
  return NextResponse.json({ success: true, rating });
}
