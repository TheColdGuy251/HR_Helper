import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { asUuid } from '@/lib/ids';
import { pollState, uuidError, validationError } from '@/lib/news';

// Голос в опросе новости (повторный клик по своему варианту - снятие голоса).

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
  if (value === undefined) return validationError(['body', 'option_id'], 'missing', 'Field required', null);
  const optionId = asUuid(value);
  if (!optionId) return uuidError(['body', 'option_id'], value);

  const option = await prisma.poll_options.findUnique({
    where: { id: optionId },
    include: { poll: true },
  });
  // Опросы мессенджера голосуются через /api/messenger/poll/vote.
  if (!option || !option.poll.post_id) return notFound('Вариант не найден');
  const poll = option.poll;

  const key = { option_id_user_id: { option_id: option.id, user_id: user.id } };
  const already = await prisma.poll_votes.findUnique({ where: key });
  if (already) {
    await prisma.poll_votes.delete({ where: key }); // повторный клик - снять голос
  } else {
    await prisma.$transaction(async (tx) => {
      if (!poll.allow_multiple) {
        // одиночный выбор - снимаем прежние голоса пользователя в этом опросе
        await tx.poll_votes.deleteMany({ where: { user_id: user.id, option: { poll_id: poll.id } } });
      }
      await tx.poll_votes.create({ data: { option_id: option.id, user_id: user.id } });
    });
  }

  return NextResponse.json({ success: true, poll: await pollState(poll, user.id) });
}
