import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, forbidden, notFound, requireUser } from '@/lib/auth';
import { pyBool } from '@/lib/kb';
import { publish } from '@/lib/events';
import { bodyParams, messageById, peerKeyOf, recipientsOf } from '@/lib/messenger';

// Правка своего сообщения.
// Порт POST /api/messenger/edit из backend/routes/messenger.py.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const messageId = p.int('message_id');
  const rawContent = p.str('content', '');
  const invalid = p.invalid();
  if (invalid) return invalid;

  const msg = await messageById(messageId);
  if (!msg) return notFound('Сообщение не найдено');
  if (msg.sender_id !== me) return forbidden('Можно редактировать только свои сообщения');
  // Пустая мета в Python ложна, поэтому проверяем именно «истинность» значения.
  if (pyBool(msg.forwarded_meta)) return badRequest('Пересланное сообщение нельзя редактировать');

  const content = rawContent.trim();
  if (!content) return badRequest('Пустое сообщение');

  await prisma.user_messages.update({
    where: { id: msg.id },
    data: { content, is_edited: true },
  });

  for (const uid of new Set(await recipientsOf(msg))) {
    publish(uid, {
      type: 'user_message_edited',
      id: msg.id,
      content,
      peer_key: peerKeyOf(msg, uid),
    });
  }
  return NextResponse.json({ ok: true, content });
}
