import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { dialogueStreams, requireOwnDialogue } from '@/lib/chat';

// Незавершённые генерации диалога.
// Фронт спрашивает при открытии диалога: если ответ ещё пишется, он покажет
// накопленный текст и переподпишется на SSE.
//
// Реестр стримов живёт в памяти процесса Next - после его перезапуска список
// пуст.

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const own = await requireOwnDialogue(
    request.nextUrl.searchParams.get('dialogue_id'),
    gate.user.id,
    ['query', 'dialogue_id']
  );
  if ('response' in own) return own.response;

  const active = dialogueStreams(own.id)
    .filter((st) => !st.finished)
    .map((st) => ({
      message_id: st.message_id,
      content: st.content,
      last_seq: st.last_seq,
      started_at: isoUtc(st.started_at),
    }));

  return NextResponse.json({ success: true, active });
}

/** POST на этом пути нет - отвечаем 405 с телом {detail}, а не стандартным 405 Next. */
export async function POST() {
  return NextResponse.json({ detail: 'Method Not Allowed' }, { status: 405 });
}
