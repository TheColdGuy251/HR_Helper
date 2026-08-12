import type { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { publish, subscribe, type SseEvent } from '@/lib/events';

// SSE-канал уведомлений: один поток на вкладку.
// Порт GET /api/events из backend/routes/events.py.
//
// Пока часть эндпоинтов остаётся на FastAPI (/api/messenger/ask, /api/chat/*),
// поток дополнительно ретранслирует события Python-хаба — см. bridgeBackend().

// Стрим нельзя ни кэшировать, ни выполнять на Edge: реестр подписчиков
// (lib/events) живёт в памяти процесса Node вместе с обработчиками мессенджера.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KEEPALIVE_MS = 15_000;
const HELLO = 'data: {"type":"hello"}\n\n';
const PING = 'data: {"type":"ping"}\n\n';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

/** Кадр SSE. json.dumps(ensure_ascii=False) и JSON.stringify дают один результат. */
function frame(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Ретрансляция событий из FastAPI.
 *
 * События, которые публикует ещё не перенесённый Python-код (ai_stream от
 * /api/messenger/ask, generation_done и dialogue_title от /api/chat), попадают
 * в ЕГО хаб уведомлений. Браузер к нему больше не подключается — он открывает
 * этот маршрут. Без ретрансляции такие события просто исчезали бы, и ответы
 * ассистента в мессенджере перестали бы стримиться.
 *
 * Соединение поднимается «мягко»: недоступный бэкенд не ломает основной поток.
 */
async function bridgeBackend(
  request: NextRequest,
  userId: number,
  signal: AbortSignal
): Promise<void> {
  const cookie = request.headers.get('cookie');
  if (!cookie) return; // без сессионной cookie FastAPI ответит 401

  let upstream: Response;
  try {
    upstream = await fetch(new URL('/api/events', BACKEND_URL), {
      headers: { cookie, accept: 'text/event-stream' },
      signal,
      cache: 'no-store',
    });
  } catch {
    return; // бэкенд не поднят — работаем только на своих событиях
  }
  if (!upstream.ok || !upstream.body) return;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split('\n')) {
          const m = /^data:\s?(.*)$/.exec(line);
          if (!m) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(m[1]);
          } catch {
            continue;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          const event = parsed as SseEvent;
          // hello/ping — служебные кадры чужого потока, свои мы шлём сами.
          // presence FastAPI тоже пропускаем: там своё представление о том,
          // кто в сети (его хаб видит только это мостовое соединение).
          if (event.type === 'hello' || event.type === 'ping' || event.type === 'presence') continue;
          publish(userId, event);
        }
      }
    }
  } catch {
    // Обрыв моста (в т.ч. по abort при закрытии вкладки) — не ошибка.
  }
}

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const userId = gate.user.id;

  // Мост к FastAPI отменяем тем же сигналом, что и основной поток.
  const bridgeAbort = new AbortController();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;

      function finish(): void {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        timer = null;
        // Отписка обязательна: без неё пользователь навсегда останется «онлайн».
        unsubscribe?.();
        unsubscribe = null;
        bridgeAbort.abort();
        request.signal.removeEventListener('abort', finish);
        try {
          controller.close();
        } catch {
          // поток уже закрыт получателем
        }
      }

      // Keepalive «по простою», как asyncio.wait_for(q.get(), timeout=15) в
      // Python: ping уходит, только если 15 с не было ни одного события.
      function arm(): void {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => send(PING), KEEPALIVE_MS);
      }

      function send(chunk: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          finish(); // получатель отвалился между проверками
          return;
        }
        arm();
      }

      cleanup = finish;
      send(HELLO);
      unsubscribe = subscribe(userId, (event) => send(frame(event)));
      // Обрыв клиента: Next гасит request.signal, поток может и не отмениться.
      request.signal.addEventListener('abort', finish);
      void bridgeBackend(request, userId, bridgeAbort.signal);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      // Starlette добавляет charset к любому text/* — повторяем.
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
