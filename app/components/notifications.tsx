'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Bot, CheckCheck, MessagesSquare, TriangleAlert } from 'lucide-react';
import { apiGet, apiPost, timeAgo } from '@/lib/api';

// Центр уведомлений (порт static/js/notifications.js).
// Данные: GET /api/notifications -> {counts, messenger[], ai[], system[]}.

interface MessengerItem {
  peer_key: string;
  is_general?: boolean;
  name: string;
  initials?: string;
  preview?: string;
  at?: string;
  unread: number;
}
interface AiItem {
  session_id: string;
  title: string;
  preview?: string;
  at?: string;
  unread?: number;
}
interface SystemItem {
  id: number;
  title?: string;
  body?: string;
  url?: string;
  diff_url?: string;
  at?: string;
  created_at?: string;
  is_read: boolean;
}
interface NotificationsData {
  counts: { messenger?: number; ai?: number; system?: number };
  messenger: MessengerItem[];
  ai: AiItem[];
  system: SystemItem[];
}

type TabKey = 'messenger' | 'ai' | 'system';

const TABS: { key: TabKey; label: string; icon: typeof Bell }[] = [
  { key: 'messenger', label: 'Сообщения', icon: MessagesSquare },
  { key: 'ai', label: 'Ассистент', icon: Bot },
  { key: 'system', label: 'Системные', icon: TriangleAlert },
];

// Подписка на Web Push — запрашивается по клику на колокольчик (жест пользователя).
async function ensurePushSubscription() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission === 'denied') return;
    const { key, available } = await apiGet<{ key: string; available: boolean }>('/api/push/vapid-public-key');
    if (!available || !key) return;
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
      const appKey = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    }
    await apiPost('/api/push/subscribe', {
      subscription: { ...sub.toJSON(), ua: navigator.userAgent },
    });
  } catch {
    /* пуши опциональны — молча пропускаем */
  }
}

export function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('messenger');
  const [data, setData] = useState<NotificationsData | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pushAsked = useRef(false);

  const reload = useCallback(async () => {
    try {
      setData(await apiGet<NotificationsData>('/api/notifications'));
    } catch {
      /* сеть моргнула */
    }
  }, []);

  // Обновление событийное (SSE) + редкий фолбэк, как в legacy.
  useEffect(() => {
    reload();
    const events = ['hr:user-message', 'hr:user-read', 'hr:unread-changed', 'hr:dialogues-changed', 'hr:system-notification'];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 300);
    };
    events.forEach((e) => window.addEventListener(e, debounced));
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 180_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') debounced();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      events.forEach((e) => window.removeEventListener(e, debounced));
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
      if (timer) clearTimeout(timer);
    };
  }, [reload]);

  // Закрытие по клику вне панели
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const counts = data?.counts || {};
  const total = (counts.messenger || 0) + (counts.ai || 0) + (counts.system || 0);

  const toggle = () => {
    setOpen((v) => !v);
    reload();
    if (!pushAsked.current) {
      pushAsked.current = true;
      ensurePushSubscription();
    }
  };

  const openMessengerItem = (item: MessengerItem) => {
    setOpen(false);
    try {
      sessionStorage.setItem(
        'msgrOpenConv',
        JSON.stringify({ peer_key: item.peer_key, is_general: !!item.is_general, name: item.name })
      );
    } catch {
      /* приватный режим */
    }
    router.push('/messenger');
  };

  const openAiItem = (item: AiItem) => {
    setOpen(false);
    router.push(`/chat/${item.session_id}`);
  };

  const openSystemItem = async (item: SystemItem) => {
    try {
      await apiPost(`/api/notifications/${item.id}/read`);
    } catch {
      /* noop */
    }
    reload();
    const url = item.url || item.diff_url;
    if (url) window.open(url, '_blank', 'noopener');
  };

  const markAllSystemRead = async () => {
    try {
      await apiPost('/api/notifications/system/read');
    } catch {
      /* noop */
    }
    reload();
  };

  const items: (MessengerItem | AiItem | SystemItem)[] = (data?.[tab] as never) || [];

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={toggle}
        className="relative p-2 hover:bg-gray-50 rounded-xl transition text-gray-500"
        title="Уведомления"
      >
        <Bell size={18} />
        {total > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 max-w-[calc(100vw-2rem)] bg-white border border-gray-100 rounded-2xl shadow-xl shadow-slate-200/70 z-[80] overflow-hidden animate-fade-in">
          <div className="p-4 border-b border-gray-50 flex items-center justify-between">
            <span className="font-bold text-sm text-[#0f1c3f]">Уведомления</span>
          </div>

          <div className="flex items-center gap-1 px-3 pt-2 border-b border-gray-100 text-xs font-semibold">
            {TABS.map(({ key, label, icon: Icon }) => {
              const n = counts[key] || 0;
              return (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`flex items-center gap-1.5 px-3 py-2 border-b-2 transition ${
                    tab === key
                      ? 'border-[#2563eb] text-[#2563eb]'
                      : 'border-transparent text-gray-400 hover:text-slate-700'
                  }`}
                >
                  <Icon size={14} />
                  <span>{label}</span>
                  {n > 0 && (
                    <span className="min-w-[16px] h-4 px-1 bg-[#2563eb] text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {tab === 'system' && items.some((i) => !(i as SystemItem).is_read) && (
              <button
                onClick={markAllSystemRead}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-[#2563eb] hover:bg-blue-50/50 transition border-b border-gray-50"
              >
                <CheckCheck size={14} />
                <span>Отметить все просмотренными</span>
              </button>
            )}

            {items.length === 0 ? (
              <p className="text-center text-gray-400 text-xs py-10">
                {tab === 'messenger'
                  ? 'Непрочитанных сообщений нет'
                  : tab === 'ai'
                    ? 'Непрочитанных ответов ассистента нет'
                    : 'Системных уведомлений нет'}
              </p>
            ) : tab === 'messenger' ? (
              (items as MessengerItem[]).map((i) => (
                <button
                  key={i.peer_key}
                  onClick={() => openMessengerItem(i)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition text-left border-b border-gray-50 last:border-b-0"
                >
                  <div className="w-9 h-9 bg-emerald-500 rounded-xl flex items-center justify-center text-white font-bold text-xs shrink-0">
                    {i.initials || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-700 truncate">{i.name}</p>
                    <p className="text-xs text-gray-400 truncate">{i.preview || ''}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-[10px] text-gray-400">{timeAgo(i.at)}</span>
                    <span className="min-w-[18px] h-[18px] px-1 bg-emerald-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                      {i.unread}
                    </span>
                  </div>
                </button>
              ))
            ) : tab === 'ai' ? (
              (items as AiItem[]).map((i) => (
                <button
                  key={i.session_id}
                  onClick={() => openAiItem(i)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition text-left border-b border-gray-50 last:border-b-0"
                >
                  <div className="w-9 h-9 bg-[#2563eb] rounded-xl flex items-center justify-center text-white shrink-0">
                    <Bot size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-700 truncate">{i.title}</p>
                    <p className="text-xs text-gray-400 truncate">{i.preview || 'Ответ ассистента готов'}</p>
                  </div>
                  <span className="text-[10px] text-gray-400 shrink-0">{timeAgo(i.at)}</span>
                </button>
              ))
            ) : (
              (items as SystemItem[]).map((i) => (
                <button
                  key={i.id}
                  onClick={() => openSystemItem(i)}
                  className={`w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition text-left border-b border-gray-50 last:border-b-0 ${
                    i.is_read ? 'opacity-60' : ''
                  }`}
                >
                  <div className="w-9 h-9 bg-amber-400 rounded-xl flex items-center justify-center text-white shrink-0 mt-0.5">
                    <TriangleAlert size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-700">{i.title || 'Системное уведомление'}</p>
                    {i.body && <p className="text-xs text-gray-400 mt-0.5">{i.body}</p>}
                  </div>
                  <span className="text-[10px] text-gray-400 shrink-0">{timeAgo(i.at || i.created_at)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
