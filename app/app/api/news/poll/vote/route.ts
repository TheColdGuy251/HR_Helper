import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { pollState, validationError } from '@/lib/news';

// Голос в опросе новости (повторный клик по своему варианту — снятие голоса).
// Порт POST /api/news/poll/vote из backend/routes/news.py (vote_poll).

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return validationError(['body'], 'json_invalid', 'JSON decode error', null);
  }
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const value = body.option_id;
  const optionId =
    typeof value === 'number' && Number.isInteger(value)
      ? value
      : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())
        ? Number.parseInt(value, 10)
        : null;
  if (optionId === null) {
    return value === undefined
      ? validationError(['body', 'option_id'], 'missing', 'Field required', null)
      : validationError(
          ['body', 'option_id'],
          'int_parsing',
          'Input should be a valid integer, unable to parse string as an integer',
          value
        );
  }

  const option = await prisma.news_poll_options.findUnique({ where: { id: optionId } });
  if (!option) return notFound('Вариант не найден');
  const poll = await prisma.news_polls.findUnique({ where: { id: option.poll_id } });
  if (!poll) return notFound('Голосование не найдено');

  const already = await prisma.news_poll_votes.findFirst({
    where: { poll_id: poll.id, option_id: option.id, user_id: user.id },
  });
  if (already) {
    await prisma.news_poll_votes.delete({ where: { id: already.id } }); // повторный клик — снять голос
  } else {
    if (!poll.allow_multiple) {
      // одиночный выбор — снимаем прежние голоса пользователя в этом опросе
      await prisma.news_poll_votes.deleteMany({ where: { poll_id: poll.id, user_id: user.id } });
    }
    await prisma.news_poll_votes.create({
      data: { poll_id: poll.id, option_id: option.id, user_id: user.id },
    });
  }

  return NextResponse.json({ success: true, poll: await pollState(poll, user.id) });
}
