import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { validationError } from '@/lib/news';

// Список вложений сессии. Порт GET /api/chat/session-files.

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

  // Только «ожидающие» вложения (ещё не привязанные к сообщению) — это и есть
  // очередь на прикрепление к следующему сообщению.
  const items = await prisma.session_documents.findMany({
    where: { session_id: sessionId, message_id: null },
    orderBy: { id: 'asc' },
    select: { id: true, filename: true, size_bytes: true, char_count: true, created_at: true },
  });

  return NextResponse.json({
    success: true,
    items: items.map((d) => ({
      id: d.id,
      name: d.filename,
      size: d.size_bytes,
      chars: d.char_count,
      // Python отдаёт `created_at.isoformat()` — без метки зоны (в отличие от
      // сообщений чата, где стоит +00:00). Сохраняем как есть.
      created_at: isoUtc(d.created_at),
    })),
  });
}
