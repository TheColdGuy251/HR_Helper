import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { asUuid } from '@/lib/ids';
import { validationError } from '@/lib/news';
import { requireOwnDialogue } from '@/lib/chat';

// Отметка сообщений прочитанными.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  let body: { dialogue_id?: unknown; message_ids?: unknown };
  try {
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return validationError(['body', 0], 'json_invalid', 'JSON decode error', {});
  }

  const own = await requireOwnDialogue(body.dialogue_id, user.id, ['body', 'dialogue_id']);
  if ('response' in own) return own.response;

  const ids = Array.isArray(body.message_ids)
    ? body.message_ids.map(asUuid).filter((v): v is string => v !== null)
    : [];

  if (ids.length) {
    await prisma.chat_messages.updateMany({
      where: { dialogue_id: own.id, id: { in: ids } },
      data: { is_read: true },
    });
    // Событие unread_changed не публикуем: счётчик обновится по опросу.
  }
  return NextResponse.json({ success: true });
}
