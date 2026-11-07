import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { asUuid } from '@/lib/ids';
import { validationError } from '@/lib/news';
import { getStream, requireOwnDialogue } from '@/lib/chat';

// Отмена генерации ("Стоп").
// Флаг cancelled читает цикл runGeneration: он прервёт выдачу чанков, а SSE
// закроется штатным done-кадром - поэтому ответ всегда success:true, даже
// если стрим уже завершился и из реестра пропал.

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  let body: { dialogue_id?: unknown; assistant_message_id?: unknown };
  try {
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return validationError(['body', 0], 'json_invalid', 'JSON decode error', {});
  }

  const own = await requireOwnDialogue(body.dialogue_id, gate.user.id, ['body', 'dialogue_id']);
  if ('response' in own) return own.response;

  const messageId = asUuid(body.assistant_message_id);
  if (messageId) {
    const st = getStream(messageId);
    // Стрим чужого диалога не останавливаем, даже зная id сообщения.
    if (st && st.dialogue_id === own.id) {
      st.cancelled = true;
      st.event.set();
    }
  }
  return NextResponse.json({ success: true });
}

/** GET на этом пути нет - отвечаем 405 с телом {detail}, а не стандартным 405 Next. */
export async function GET() {
  return NextResponse.json({ detail: 'Method Not Allowed' }, { status: 405 });
}
