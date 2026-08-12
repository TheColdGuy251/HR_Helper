'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

// Глобальный SSE-канал `GET /api/events` — сервер пушит события вместо поллинга.
// Портировано из static/js/scripts.js (openEvents): каждое серверное событие
// ре-диспатчится как DOM CustomEvent `hr:*`, чтобы страницы подписывались через
// window.addEventListener, как и в исходном приложении.
//
// ВАЖНО: присутствие (онлайн-статус) в бэкенде выводится из открытых
// SSE-подключений, поэтому канал живёт на уровне layout — одно соединение
// на вкладку на всё время работы SPA.

const EVENT_MAP: Record<string, string> = {
  generation_done: 'hr:dialogues-changed',
  dialogue_title: 'hr:dialogues-changed',
  user_message: 'hr:user-message',
  user_typing: 'hr:user-typing',
  user_message_deleted: 'hr:user-deleted',
  user_message_pinned: 'hr:user-pinned',
  user_read: 'hr:user-read',
  user_message_edited: 'hr:user-edited',
  reaction_updated: 'hr:reaction',
  poll_updated: 'hr:poll',
  ai_stream: 'hr:ai-stream',
  system_notification: 'hr:system-notification',
  unread_changed: 'hr:unread-changed',
  presence: 'hr:presence',
};

export function EventsBridge() {
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/events');
    } catch {
      return;
    }

    es.onmessage = (ev) => {
      let data: { type?: string; message?: unknown } | null = null;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!data?.type || data.type === 'ping' || data.type === 'hello') return;

      const domEvent = EVENT_MAP[data.type];
      if (!domEvent) return;
      // user_message несёт полезную нагрузку в поле message (как в scripts.js)
      const detail = data.type === 'user_message' ? data.message : data;
      window.dispatchEvent(new CustomEvent(domEvent, { detail }));
    };
    // при ошибке EventSource переподключается сам

    return () => {
      try {
        es?.close();
      } catch {
        /* noop */
      }
    };
  }, []);

  return null;
}

// ---------------------------------------------------------------------------
// Тосты: window.dispatchEvent(new CustomEvent('hr:toast', {detail: {...}}))
// ---------------------------------------------------------------------------

export interface ToastData {
  id?: number;
  title: string;
  body?: string;
  url?: string;
}

export function toast(t: ToastData) {
  window.dispatchEvent(new CustomEvent('hr:toast', { detail: t }));
}

// Порт window.HRToast (scripts.js:319-511): очередь показа, до 3 тостов на
// десктопе и ровно 1 на мобильном, полоска обратного отсчёта, свайп-закрытие.

const TOAST_TIMEOUT = 6000;
const MAX_DESKTOP = 3;

type ToastItem = Required<ToastData>;

interface ToastQueue {
  active: ToastItem[]; // видимые сейчас
  queue: ToastItem[]; // ждут освободившегося места
}

/** Переливает из очереди в показ, пока есть места. Идемпотентна. */
function pump(s: ToastQueue, max: number): ToastQueue {
  const free = max - s.active.length;
  if (free <= 0 || !s.queue.length) return s;
  return { active: [...s.active, ...s.queue.slice(0, free)], queue: s.queue.slice(free) };
}

/** На телефоне тосты показываем сверху и по одному (как isMobile в легаси). */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return mobile;
}

function ToastCard({
  item,
  mobile,
  onClose,
  onHideAll,
}: {
  item: ToastItem;
  mobile: boolean;
  onClose: () => void;
  onHideAll: () => void;
}) {
  const [running, setRunning] = useState(false); // запускает полоску отсчёта
  const [shift, setShift] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number; mode: 'x' | 'up' | null } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Полоску запускаем следующим кадром — иначе transition не проиграется.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRunning(true));
    const timer = setTimeout(() => closeRef.current(), TOAST_TIMEOUT);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, []);

  // Смахивание: влево/вправо — закрыть текущий, вверх — скрыть все.
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, mode: null };
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = e.touches[0].clientX - s.x;
    const dy = e.touches[0].clientY - s.y;
    if (!s.mode && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      s.mode = dy < 0 && Math.abs(dy) > Math.abs(dx) ? 'up' : 'x';
    }
    if (!s.mode) return;
    setShift(s.mode === 'up' ? { x: 0, y: Math.min(0, dy) } : { x: dx, y: 0 });
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const s = start.current;
    start.current = null;
    if (!s?.mode) {
      setShift(null);
      return;
    }
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (s.mode === 'up' && dy < -55) {
      onHideAll();
      return;
    }
    if (s.mode === 'x' && Math.abs(dx) > 80) {
      setShift({ x: dx > 0 ? 600 : -600, y: 0 }); // уезжает за край
      setTimeout(onClose, 180);
      return;
    }
    setShift(null); // не хватило — возвращаем на место
  };

  const drift = shift ? Math.abs(shift.x) + Math.abs(shift.y) : 0;

  return (
    <div
      className="relative bg-white border border-gray-100 rounded-2xl shadow-xl shadow-slate-200/60 overflow-hidden animate-fade-in cursor-pointer"
      style={{
        // touch-action: none нужен, чтобы жест не уходил в прокрутку страницы
        touchAction: mobile ? 'none' : undefined,
        transform: shift ? `translate(${shift.x}px, ${shift.y}px)` : undefined,
        opacity: shift ? Math.max(0.2, 1 - drift / 200) : undefined,
        transition: start.current ? 'none' : 'transform .18s ease, opacity .18s ease',
      }}
      onTouchStart={mobile ? onTouchStart : undefined}
      onTouchMove={mobile ? onTouchMove : undefined}
      onTouchEnd={mobile ? onTouchEnd : undefined}
      onClick={() => {
        if (item.url) window.location.href = item.url;
        onClose();
      }}
    >
      <div className="p-4 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-[#0f1c3f] truncate">{item.title}</p>
          {item.body && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{item.body}</p>}
        </div>
        <button
          type="button"
          aria-label="Закрыть уведомление"
          className="p-1 text-gray-300 hover:text-gray-500 transition shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Полоска обратного отсчёта (порт .toast-progress-bar) */}
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-gray-100">
        <div
          className="h-full bg-[#2563eb]"
          style={{
            width: running ? '0%' : '100%',
            transition: `width ${TOAST_TIMEOUT}ms linear`,
          }}
        />
      </div>

      {mobile && <span className="sr-only">Смахните, чтобы закрыть</span>}
    </div>
  );
}

export function Toaster() {
  const mobile = useIsMobile();
  const max = mobile ? 1 : MAX_DESKTOP;
  const maxRef = useRef(max);
  maxRef.current = max;

  const [state, setState] = useState<ToastQueue>({ active: [], queue: [] });

  const close = useCallback((id: number) => {
    setState((s) =>
      pump(
        { active: s.active.filter((t) => t.id !== id), queue: s.queue.filter((t) => t.id !== id) },
        maxRef.current
      )
    );
  }, []);

  const hideAll = useCallback(() => setState({ active: [], queue: [] }), []);

  // Сменилась ширина экрана — переливаем очередь под новый лимит.
  useEffect(() => setState((s) => pump(s, max)), [max]);

  useEffect(() => {
    let counter = 1;
    const onToast = (e: Event) => {
      const d = (e as CustomEvent<ToastData>).detail;
      if (!d?.title) return;
      const item: ToastItem = { id: counter++, title: d.title, body: d.body || '', url: d.url || '' };
      setState((s) => pump({ active: s.active, queue: [...s.queue, item] }, maxRef.current));
    };
    // Системные уведомления из SSE показываем как тосты автоматически.
    const onSystem = (e: Event) => {
      const d = (e as CustomEvent<{ title?: string; body?: string; url?: string }>).detail;
      if (d?.title || d?.body) {
        toast({ title: d.title || 'Уведомление', body: d.body, url: d.url });
      }
    };
    window.addEventListener('hr:toast', onToast);
    window.addEventListener('hr:system-notification', onSystem);
    return () => {
      window.removeEventListener('hr:toast', onToast);
      window.removeEventListener('hr:system-notification', onSystem);
    };
  }, []);

  if (!state.active.length) return null;

  // На телефоне — сверху; на десктопе bottom-24, над плавающей кнопкой мессенджера.
  return (
    <div
      className={`fixed z-[90] flex flex-col gap-2 ${
        mobile ? 'top-4 inset-x-4' : 'bottom-24 right-4 w-80 max-w-[calc(100vw-2rem)]'
      }`}
    >
      {state.active.map((t) => (
        <ToastCard
          key={t.id}
          item={t}
          mobile={mobile}
          onClose={() => close(t.id)}
          onHideAll={hideAll}
        />
      ))}

      {/* «Скрыть все» — только на десктопе при стеке (на телефоне свайп вверх) */}
      {!mobile && state.active.length + state.queue.length >= 2 && (
        <button
          type="button"
          onClick={hideAll}
          className="self-end px-3 py-1.5 rounded-full bg-white/90 border border-gray-100 shadow-sm text-[11px] font-semibold text-gray-500 hover:text-[#2563eb] transition"
        >
          Скрыть все{state.queue.length > 0 ? ` (+${state.queue.length})` : ''}
        </button>
      )}
    </div>
  );
}
