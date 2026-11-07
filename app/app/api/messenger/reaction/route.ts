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

// Реакция-эмодзи на сообщение (один пользователь - одна реакция).

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const messageId = p.uuid('message_id');
  const emoji = p.str('emoji');
  const invalid = p.invalid();
  if (invalid) return invalid;

  const msg = await messageById(messageId);
  if (!msg) return notFound('Сообщение не найдено');
  if (!msg.is_general && me !== msg.sender_id && me !== msg.recipient_id) {
    return forbidden('Нет доступа');
  }

  // Ключ реакции - (сообщение, пользователь): у пользователя одна реакция.
  const key = { message_id_user_id: { message_id: msg.id, user_id: me } };
  const existing = await prisma.user_message_reactions.findUnique({ where: key });
  if (existing && existing.emoji === emoji) {
    await prisma.user_message_reactions.delete({ where: key }); // повторный клик - снять
  } else {
    await prisma.user_message_reactions.upsert({
      where: key,
      create: { message_id: msg.id, user_id: me, emoji },
      update: { emoji },
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
