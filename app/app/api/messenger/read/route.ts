import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { bodyParams, doRead } from '@/lib/messenger';

// Лёгкая отметка прочтения диалога (HTTP-фолбэк WS-сигнала).
// Порт POST /api/messenger/read из backend/routes/messenger.py.
//
// Ошибок не возвращает: несуществующий собеседник просто ничего не меняет
// (в Python _do_read молча выходит) — клиент дёргает этот метод по фокусу окна.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const peerId = p.optInt('peer_id');
  const general = p.bool('general', false);
  const invalid = p.invalid();
  if (invalid) return invalid;

  await doRead(gate.user.id, peerId, general);
  return NextResponse.json({ ok: true });
}
