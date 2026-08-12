import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { forbidden, notFound, requireUser } from '@/lib/auth';
import { publish } from '@/lib/events';
import {
  bodyParams,
  messageById,
  peerKeyOf,
  reactionsForViewers,
  recipientsOf,
} from '@/lib/messenger';

// Реакция-эмодзи на сообщение (один пользователь — одна реакция).
// Порт POST /api/messenger/reaction из backend/routes/messenger.py.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const messageId = p.int('message_id');
  const emoji = p.str('emoji');
  const invalid = p.invalid();
  if (invalid) return invalid;

  const msg = await messageById(messageId);
  if (!msg) return notFound('Сообщение не найдено');
  if (!msg.is_general && me !== msg.sender_id && me !== msg.recipient_id) {
    return forbidden('Нет доступа');
  }

  const existing = await prisma.user_message_reactions.findFirst({
    where: { message_id: msg.id, user_id: me },
    orderBy: { id: 'asc' },
  });
  if (existing && existing.emoji === emoji) {
    await prisma.user_message_reactions.delete({ where: { id: existing.id } }); // повторный клик — снять
  } else if (existing) {
    await prisma.user_message_reactions.update({ where: { id: existing.id }, data: { emoji } });
  } else {
    await prisma.user_message_reactions.create({
      data: { message_id: msg.id, user_id: me, emoji },
    });
  }

  const recipients = [...new Set(await recipientsOf(msg))];
  const byViewer = await reactionsForViewers(msg.id, [...recipients, me]);
  for (const uid of recipients) {
    publish(uid, {
      type: 'reaction_updated',
      id: msg.id,
      reactions: byViewer.get(uid),
      peer_key: peerKeyOf(msg, uid),
    });
  }
  return NextResponse.json({ ok: true, reactions: byViewer.get(me) });
}
