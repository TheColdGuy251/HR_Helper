import 'server-only';
import { isoUtc } from './db';

/**
 * Шина серверных событий для SSE-канала `/api/events`.
 *
 * Ограничение: реестр подписчиков живёт в памяти одного процесса. Если
 * запустить несколько инстансов Next (кластер, PM2, несколько контейнеров),
 * событие увидят только те пользователи, чьё SSE-соединение обслуживает тот же
 * процесс, что и обработчик HTTP-запроса.
 *
 * Присутствие выводится из наличия открытых подписок - отдельного хранилища
 * "онлайн" нет: пока у пользователя есть хотя бы один живой SSE-поток, он в
 * сети. Поэтому важно снимать подписку при обрыве соединения, иначе статус
 * "залипнет" до перезапуска процесса.
 */

export type SseEvent = Record<string, unknown>;

/** Приёмник кадров - обёртка над контроллером открытого SSE-потока. */
export type EventSink = (event: SseEvent) => void;

interface EventBus {
  subscribers: Map<string, Set<EventSink>>;
  /** Момент последней активности соединения (подписка/отписка). */
  lastSeen: Map<string, Date>;
}

// В dev Next перезагружает модули на каждое изменение файла. Если держать
// реестр в модульной переменной, после hot-reload обработчики API окажутся с
// пустым реестром, а уже открытые SSE-потоки - "потерянными": события никуда
// не пойдут, а присутствие зависнет. Кладём в globalThis, как PrismaClient.
const globalForEvents = globalThis as unknown as { hrEventBus?: EventBus };
const bus: EventBus = (globalForEvents.hrEventBus ??= {
  subscribers: new Map(),
  lastSeen: new Map(),
});

/**
 * Подписывает соединение пользователя на события. Возвращает функцию отписки -
 * её обязательно вызывать при закрытии потока.
 *
 * При первой подписке пользователя всем подключённым уходит presence online.
 * Событие получает в том числе сам подписавшийся: его сокет уже в реестре к
 * моменту рассылки.
 */
export function subscribe(userId: string, sink: EventSink): () => void {
  const existing = bus.subscribers.get(userId);
  const wasOnline = Boolean(existing && existing.size);
  if (existing) existing.add(sink);
  else bus.subscribers.set(userId, new Set([sink]));
  bus.lastSeen.set(userId, new Date());

  if (!wasOnline) {
    broadcast({ type: 'presence', user_id: userId, online: true });
  }

  let released = false;
  return () => {
    if (released) return; // отписка идемпотентна: abort и cancel потока приходят оба
    released = true;
    unsubscribe(userId, sink);
  };
}

function unsubscribe(userId: string, sink: EventSink): void {
  const subs = bus.subscribers.get(userId);
  if (subs) {
    subs.delete(sink);
    if (!subs.size) bus.subscribers.delete(userId);
  }
  const now = new Date();
  bus.lastSeen.set(userId, now);
  // Последнее соединение закрылось - собеседники гасят "Онлайн" без поллинга.
  if (!bus.subscribers.get(userId)?.size) {
    broadcast({ type: 'presence', user_id: userId, online: false, last_seen: isoUtc(now) });
  }
}

/** Доставляет событие всем соединениям пользователя. No-op без подписчиков. */
export function publish(userId: string | null | undefined, event: SseEvent): void {
  if (!userId) return;
  const subs = bus.subscribers.get(userId);
  if (!subs || !subs.size) return;
  // Копия набора: приёмник может закрыться прямо во время рассылки.
  for (const sink of [...subs]) {
    try {
      sink(event);
    } catch {
      // Поток уже закрыт - отписку сделает его собственный cleanup.
    }
  }
}

/** Доставляет событие всем подключённым пользователям. */
export function broadcast(event: SseEvent): void {
  for (const userId of [...bus.subscribers.keys()]) {
    publish(userId, event);
  }
}

/** Идентификаторы пользователей с хотя бы одним открытым SSE-потоком. */
export function onlineUsers(): string[] {
  return [...bus.subscribers.keys()];
}

export function isOnline(userId: string): boolean {
  return Boolean(bus.subscribers.get(userId)?.size);
}

/** Момент последней активности соединения (в памяти процесса), если известен. */
export function lastSeenOf(userId: string): Date | null {
  return bus.lastSeen.get(userId) ?? null;
}
