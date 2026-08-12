import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { notFound, requireUser } from '@/lib/auth';
import { bodyParams, publishTyping, userById } from '@/lib/messenger';

// HTTP-сигнал «печатает» (в Python основной канал — WebSocket /api/messenger/ws,
// он не переносится; клиент на Next всегда ходит этим фолбэком).
// Порт POST /api/messenger/typing из backend/routes/messenger.py.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const peerId = p.optInt('peer_id');
  const general = p.bool('general', false);
  const typing = p.bool('typing', true);
  const invalid = p.invalid();
  if (invalid) return invalid;

  if (!general && (!peerId || !(await userById(peerId)))) return notFound('Получатель не найден');

  await publishTyping(gate.user, general ? null : peerId, general, typing);
  return NextResponse.json({ ok: true });
}
