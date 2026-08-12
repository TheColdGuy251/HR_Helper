import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireUser } from '@/lib/auth';
import { pyStr } from '@/lib/kb';
import {
  GENERAL_KEY,
  bodyParams,
  broadcastMessage,
  markRead,
  serializeMessage,
  threadWhere,
  userById,
} from '@/lib/messenger';

// Создание голосования в диалоге.
// Порт POST /api/messenger/poll из backend/routes/messenger.py.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const peerId = p.optInt('peer_id');
  const general = p.bool('general', false);
  const rawQuestion = p.str('question');
  const description = p.str('description', '');
  const rawOptions = p.strList('options');
  const allowMultiple = p.bool('allow_multiple', false);
  const showVoters = p.bool('show_voters', false);
  const allowChange = p.bool('allow_change', true);
  const allowBot = p.bool('allow_bot', true);
  const invalid = p.invalid();
  if (invalid) return invalid;

  const question = rawQuestion.trim();
  const options = rawOptions.map((o) => o.trim()).filter((o) => o).slice(0, 10);
  if (!question) return badRequest('Укажите вопрос голосования');
  if (options.length < 2) return badRequest('Нужно минимум 2 варианта');

  // число участников диалога должно быть > 2
  const participants = general ? await prisma.users.count({ where: { is_active: true } }) : 2;
  if (participants <= 2) {
    return badRequest('Голосование доступно только в диалоге с числом участников больше 2');
  }

  if (!general && (!peerId || !(await userById(peerId)))) return notFound('Получатель не найден');

  const msg = await prisma.user_messages.create({
    data: {
      sender_id: me,
      recipient_id: general ? null : peerId,
      is_general: general,
      content: question,
      is_pinned: false,
      is_edited: false,
      is_ai_query: false,
    },
  });
  const poll = await prisma.polls.create({
    data: {
      message_id: msg.id,
      question,
      description: description.trim() || null,
      allow_multiple: allowMultiple,
      show_voters: showVoters,
      allow_change: allowChange,
      allow_bot: allowBot,
    },
  });
  await prisma.poll_options.createMany({
    data: options.map((text, i) => ({ poll_id: poll.id, text, position: i })),
  });

  const where = threadWhere(me, peerId, general);
  await markRead(me, general ? GENERAL_KEY : pyStr(peerId), where);
  await broadcastMessage(msg);

  return NextResponse.json(await serializeMessage(msg, me));
}
