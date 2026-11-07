import type { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { publish, subscribe, type SseEvent } from '@/lib/events';

// SSE-канал уведомлений: один поток на вкладку.
//
// Если задан внешний бэкенд (BACKEND_URL), поток дополнительно ретранслирует
// его события - см. bridgeBackend().

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
 * Ретрансляция событий внешнего бэкенда (BACKEND_URL), если он поднят.
 * Соединение поднимается "мягко": недоступный бэкенд не ломает основной поток.
 */
async function bridgeBackend(
  request: NextRequest,
  userId: string,
  signal: AbortSignal
): Promise<void> {
  const cookie = request.headers.get('cookie');
  if (!cookie) return; // без сессионной cookie бэкенд ответит 401

  let upstream: Response;
  try {
    upstream = await fetch(new URL('/api/events', BACKEND_URL), {
      headers: { cookie, accept: 'text/event-stream' },
      signal,
      cache: 'no-store',
    });
  } catch {
    return; // бэкенд не поднят - работаем только на своих событиях
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
          // hello/ping - служебные кадры чужого потока, свои мы шлём сами.
          // presence тоже пропускаем: чужой хаб видит только это мостовое
          // соединение.
          if (event.type === 'hello' || event.type === 'ping' || event.type === 'presence') continue;
          publish(userId, event);
        }
      }
    }
  } catch {
    // Обрыв моста (в т.ч. по abort при закрытии вкладки) - не ошибка.
  }
}

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const userId = gate.user.id;

  // Мост отменяем тем же сигналом, что и основной поток.
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
        // Отписка обязательна: без неё пользователь навсегда останется "онлайн".
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

      // Keepalive "по простою": ping уходит, только если 15 с не было ни одного
      // события.
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
      // charset для text/* указываем явно.
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
