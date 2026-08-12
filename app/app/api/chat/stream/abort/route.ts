import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { validationError } from '@/lib/news';
import { getStream } from '@/lib/chat';

// Отмена генерации («Стоп»). Порт POST /api/chat/stream/abort.
// Флаг cancelled читает цикл runGeneration: он прервёт выдачу чанков, а SSE
// закроется штатным done-кадром — поэтому ответ всегда success:true, даже
// если стрим уже завершился и из реестра пропал.

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  let body: { session_id?: unknown; assistant_message_id?: unknown };
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

  const messageId =
    typeof body.assistant_message_id === 'number' && Number.isFinite(body.assistant_message_id)
      ? Math.trunc(body.assistant_message_id)
      : null;

  // Python: `if body.assistant_message_id` — нулевой id тоже пропускается мимо.
  if (messageId) {
    const st = getStream(messageId);
    if (st) {
      st.cancelled = true;
      st.event.set();
    }
  }
  return NextResponse.json({ success: true });
}

/**
 * GET этот путь у FastAPI не обслуживает (405 Method Not Allowed). Без
 * экспорта Next вернул бы свой 405 с другой формой тела — отдаём то же,
 * что Starlette.
 */
export async function GET() {
  return NextResponse.json({ detail: 'Method Not Allowed' }, { status: 405 });
}
