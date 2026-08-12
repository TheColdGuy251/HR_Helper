import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { validationError } from '@/lib/news';
import { sessionStreams } from '@/lib/chat';

// Незавершённые генерации сессии. Порт GET /api/chat/stream/active.
// Фронт спрашивает при открытии диалога: если ответ ещё пишется, он покажет
// накопленный текст и переподпишется на SSE.
//
// Реестр стримов живёт В ПАМЯТИ процесса Next — после его перезапуска список
// пуст, ровно как у FastAPI после рестарта uvicorn.

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const sessionId = request.nextUrl.searchParams.get('session_id');
  if (sessionId === null) {
    return validationError(['query', 'session_id'], 'missing', 'Field required', null);
  }

  const session = await prisma.chat_sessions.findUnique({
    where: { id: sessionId },
    select: { id: true, dialogues: { select: { user_id: true } } },
  });
  if (!session || session.dialogues.user_id !== user.id) return notFound('Сессия не найдена');

  const active = sessionStreams(sessionId)
    .filter((st) => !st.finished)
    .map((st) => ({
      message_id: st.message_id,
      content: st.content,
      last_seq: st.last_seq,
      // Python: `started_at.isoformat()` наивного utcnow — без метки зоны.
      started_at: isoUtc(st.started_at),
    }));

  return NextResponse.json({ success: true, active });
}

/**
 * POST этот путь у FastAPI не обслуживает (405 Method Not Allowed). Без
 * экспорта Next вернул бы свой 405 с другой формой тела — отдаём то же,
 * что Starlette.
 */
export async function POST() {
  return NextResponse.json({ detail: 'Method Not Allowed' }, { status: 405 });
}
