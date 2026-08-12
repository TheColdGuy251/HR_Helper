import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { forbidden, notFound, requireUser } from '@/lib/auth';
import { publish } from '@/lib/events';
import {
  bodyParams,
  broadcastMessage,
  messageById,
  peerKeyOf,
  recipientsOf,
  threadWhere,
} from '@/lib/messenger';

// Закрепление сообщения в диалоге (закреплено может быть только одно).
// Порт POST /api/messenger/pin из backend/routes/messenger.py.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const messageId = p.int('message_id');
  const pinned = p.bool('pinned', true);
  const invalid = p.invalid();
  if (invalid) return invalid;

  const msg = await messageById(messageId);
  if (!msg) return notFound('Сообщение не найдено');
  if (!msg.is_general && me !== msg.sender_id && me !== msg.recipient_id) {
    return forbidden('Нет доступа');
  }

  // Peer с точки зрения ЗАКРЕПЛЯЮЩЕГО: закреплять можно и чужое сообщение,
  // тогда собеседник — его отправитель (а не recipient_id == сам пользователь).
  const peerOfUser = msg.is_general
    ? null
    : msg.sender_id !== me
      ? msg.sender_id
      : msg.recipient_id;

  const unpinnedIds: number[] = [];
  if (pinned) {
    // В диалоге закреплено только ОДНО сообщение — снимаем закрепление с прочих.
    const where = threadWhere(me, peerOfUser, msg.is_general);
    const others = await prisma.user_messages.findMany({
      where: { AND: [where, { is_pinned: true, id: { not: msg.id } }] },
      select: { id: true },
    });
    for (const o of others) unpinnedIds.push(o.id);
    if (unpinnedIds.length) {
      await prisma.user_messages.updateMany({
        where: { id: { in: unpinnedIds } },
        data: { is_pinned: false },
      });
    }
  }
  await prisma.user_messages.update({ where: { id: msg.id }, data: { is_pinned: pinned } });

  // Системная (серая) отметка о закреплении — её можно удалить у себя.
  // Получатель — собеседник (НЕ msg.recipient_id: при закреплении чужого
  // сообщения им оказался бы сам закрепляющий, и отметка не попала бы в диалог).
  const systemMsg = await prisma.user_messages.create({
    data: {
      sender_id: me,
      recipient_id: peerOfUser,
      is_general: msg.is_general,
      content: pinned ? 'закрепил(а) сообщение' : 'открепил(а) сообщение',
      forwarded_meta: { system: true },
      is_pinned: false,
      is_edited: false,
      is_ai_query: false,
    },
  });

  for (const uid of new Set(await recipientsOf(msg))) {
    const pk = peerKeyOf(msg, uid);
    for (const otherId of unpinnedIds) {
      publish(uid, { type: 'user_message_pinned', id: otherId, pinned: false, peer_key: pk });
    }
    publish(uid, { type: 'user_message_pinned', id: msg.id, pinned, peer_key: pk });
  }
  await broadcastMessage(systemMsg);

  return NextResponse.json({ ok: true, pinned });
}
