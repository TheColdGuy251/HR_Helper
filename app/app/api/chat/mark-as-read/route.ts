import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { validationError } from '@/lib/news';

// Отметка сообщений прочитанными. Порт POST /api/chat/mark-as-read.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  let body: { session_id?: unknown; message_ids?: unknown };
  try {
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return validationError(['body', 0], 'json_invalid', 'JSON decode error', {});
  }
  if (typeof body.session_id !== 'string') {
    return validationError(['body', 'session_id'], 'missing', 'Field required', null);
  }

  const session = await prisma.chat_sessions.findUnique({
    where: { id: body.session_id },
    select: { id: true, dialogues: { select: { user_id: true } } },
  });
  if (!session || session.dialogues.user_id !== user.id) return notFound('Сессия не найдена');

  const ids = Array.isArray(body.message_ids)
    ? body.message_ids.filter((v): v is number => typeof v === 'number' && Number.isInteger(v))
    : [];

  if (ids.length) {
    await prisma.chat_messages.updateMany({
      where: { session_id: body.session_id, id: { in: ids } },
      data: { is_read: true },
    });
    // Python здесь публикует unread_changed в SSE-шину уведомлений — она живёт
    // в процессе FastAPI и из Next недостижима (счётчик обновится по опросу).
  }
  return NextResponse.json({ success: true });
}
