import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, forbidden, notFound, requireUser } from '@/lib/auth';
import { publish } from '@/lib/events';
import {
  bodyParams,
  messageById,
  peerKeyOf,
  pollForViewers,
  recipientsOf,
} from '@/lib/messenger';

// Голос в опросе (повторный клик снимает голос, если менять разрешено).

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const optionId = p.uuid('option_id');
  const invalid = p.invalid();
  if (invalid) return invalid;

  const option = await prisma.poll_options.findUnique({
    where: { id: optionId },
    include: { poll: true },
  });
  if (!option) return notFound('Вариант не найден');

  const poll = option.poll;
  const msg = await messageById(poll.message_id);
  if (!msg || (!msg.is_general && me !== msg.sender_id && me !== msg.recipient_id)) {
    return forbidden('Нет доступа');
  }

  // Голоса пользователя в этом опросе (опрос голоса определяется вариантом).
  const mine = { user_id: me, option: { poll_id: poll.id } };
  const myVotes = await prisma.poll_votes.findMany({ where: mine, select: { option_id: true } });

  if (myVotes.some((v) => v.option_id === optionId)) {
    // снятие голоса - если разрешено менять
    if (poll.allow_change) {
      await prisma.poll_votes.delete({
        where: { option_id_user_id: { option_id: optionId, user_id: me } },
      });
    }
  } else if (poll.allow_multiple) {
    await prisma.poll_votes.create({ data: { option_id: optionId, user_id: me } });
  } else {
    // один вариант: заменяем (если менять нельзя и уже голосовал - запрет)
    if (myVotes.length && !poll.allow_change) return badRequest('Изменение ответа запрещено');
    await prisma.$transaction([
      prisma.poll_votes.deleteMany({ where: mine }),
      prisma.poll_votes.create({ data: { option_id: optionId, user_id: me } }),
    ]);
  }

  const recipients = [...new Set(await recipientsOf(msg))];
  const byViewer = await pollForViewers(msg, [...recipients, me]);
  for (const uid of recipients) {
    publish(uid, {
      type: 'poll_updated',
      id: msg.id,
      poll: byViewer.get(uid),
      peer_key: peerKeyOf(msg, uid),
    });
  }
  return NextResponse.json({ ok: true, poll: byViewer.get(me) });
}
