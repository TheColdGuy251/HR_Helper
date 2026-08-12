'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, MessagesSquare, Search } from 'lucide-react';
import { apiGet, apiPost, timeAgo } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import type { ActiveConv, ConvItem, ConversationsData, PresenceEvent, PresenceInfo } from './types';
import { initialsOf, matchesAssistant } from './types';

// Список бесед: «HR-ассистент», «Общий чат», «Заметки» и сотрудники.
// Данные — GET /api/messenger/conversations?q= (HR Helper/routes/messenger.py).
// Ряд ассистента бэкенд не отдаёт (бот hr_assistant_bot заведён с is_active=0 и
// в выдачу не попадает) — он синтетический, как в легаси messenger_page.js:108
// и messenger.js:415: клик открывает НОВЫЙ диалог в /chat (POST /api/dialogues).

const SEARCH_DEBOUNCE = 220;   // как в легаси messenger_page.js
const RELOAD_DEBOUNCE = 400;   // перезагрузка после SSE-событий
const PRESENCE_PREFETCH = 40;  // сколько онлайн-статусов тянем при первом заходе

/** last_at из /conversations приходит без таймзоны — трактуем как UTC. */
function utcIso(v: string | null | undefined): string | null {
  if (!v) return null;
  return /(?:Z|[+-]\d\d:?\d\d)$/.test(v) ? v : `${v}Z`;
}

/** Снимок беседы в хранилище: новый формат (peer_key/is_general) и легаси. */
interface StoredConv {
  key?: string;
  peer_key?: string;
  general?: boolean;
  is_general?: boolean;
  name?: string;
  initials?: string;
  position?: string;
}

function readStored(): StoredConv | null {
  let stored: StoredConv | null = null;
  try {
    stored = JSON.parse(sessionStorage.getItem('msgrOpenConv') || 'null');
    sessionStorage.removeItem('msgrOpenConv');
  } catch {
    stored = null;
  }
  if (!stored) {
    try {
      stored = JSON.parse(localStorage.getItem('mpLastConv') || 'null');
    } catch {
      stored = null;
    }
  }
  return stored && typeof stored === 'object' ? stored : null;
}

function convOf(c: ConvItem): ActiveConv {
  return {
    key: c.key,
    peerId: c.peer_id,
    general: c.key === 'general',
    notes: !!c.is_notes,
    name: c.name,
    initials: c.initials,
    position: c.position,
  };
}

/** Беседа из снимка — на случай, если её нет в текущей выдаче (например, поиск). */
function fromStored(s: StoredConv, meId: number | undefined): ActiveConv | null {
  const key = s.peer_key || s.key;
  if (!key) return null;
  const general = key === 'general' || !!(s.is_general ?? s.general);
  const peerId = general ? null : Number(key);
  if (!general && !Number.isFinite(peerId)) return null;
  return {
    key,
    peerId,
    general,
    notes: !general && peerId === meId,
    name: s.name || (general ? 'Общий чат' : 'Диалог'),
    initials: s.initials || (general ? '★' : initialsOf(s.name)),
    position: s.position || '',
  };
}

function avatarStyle(c: ConvItem): string {
  if (c.key === 'general') return 'bg-[#2563eb]';
  if (c.is_notes) return 'bg-amber-400';
  return 'bg-[#0f1c3f]';
}

export function Conversations({
  active,
  onSelect,
  autoRestore = true,
  headerExtra,
}: {
  active: ActiveConv | null;
  onSelect: (c: ActiveConv) => void;
  /** Восстанавливать последнюю открытую беседу (в мини-мессенджере — нет). */
  autoRestore?: boolean;
  headerExtra?: React.ReactNode;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [data, setData] = useState<ConversationsData | null>(null);
  const [error, setError] = useState('');
  const [online, setOnline] = useState<Record<number, boolean>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');

  const qRef = useRef('');
  const selectRef = useRef(onSelect);
  const restoredRef = useRef(false);
  const presenceRef = useRef(false);
  qRef.current = q;
  selectRef.current = onSelect;

  const load = useCallback(async (term: string): Promise<ConversationsData | null> => {
    try {
      const d = await apiGet<ConversationsData>(
        `/api/messenger/conversations?q=${encodeURIComponent(term)}`
      );
      setData(d);
      setError('');
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить список бесед');
      return null;
    }
  }, []);

  /** Онлайн-статусы собеседников — один раз при первом заходе, дальше по SSE. */
  const prefetchPresence = useCallback(async (d: ConversationsData) => {
    if (presenceRef.current) return;
    presenceRef.current = true;
    const ids = d.users
      .map((u) => u.peer_id)
      .filter((v): v is number => typeof v === 'number')
      .slice(0, PRESENCE_PREFETCH);
    if (!ids.length) return;
    const res = await Promise.allSettled(
      ids.map((id) => apiGet<PresenceInfo>(`/api/messenger/presence?peer_id=${id}`))
    );
    const map: Record<number, boolean> = {};
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') map[ids[i]] = !!r.value.online;
    });
    setOnline((prev) => ({ ...map, ...prev }));
  }, []);

  /** Восстановление открытой беседы: миничат (sessionStorage) → последняя. */
  const restore = useCallback(
    (d: ConversationsData) => {
      const stored = readStored();
      if (!stored) return;
      const key = stored.peer_key || stored.key;
      const all = [d.general, d.notes, ...d.users].filter((c): c is ConvItem => !!c);
      const item = all.find((c) => c.key === key);
      const conv = item ? convOf(item) : fromStored(stored, user?.id);
      if (conv) selectRef.current(conv);
    },
    [user?.id]
  );

  // Первая загрузка — сразу, последующие поиски — с debounce.
  useEffect(() => {
    let alive = true;
    const first = !restoredRef.current;
    const run = async () => {
      const d = await load(q);
      if (!alive || !d) return;
      if (!restoredRef.current) {
        restoredRef.current = true;
        if (autoRestore) restore(d);
      }
      prefetchPresence(d);
    };
    const t = setTimeout(run, first ? 0 : SEARCH_DEBOUNCE);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, load, restore, prefetchPresence, autoRestore]);

  // Бейджи непрочитанного и превью обновляем по событиям SSE.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => load(qRef.current), RELOAD_DEBOUNCE);
    };
    const events = ['hr:user-message', 'hr:user-read', 'hr:unread-changed', 'hr:user-deleted'];
    events.forEach((e) => window.addEventListener(e, bump));
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      if (t) clearTimeout(t);
    };
  }, [load]);

  useEffect(() => {
    const onPresence = (e: Event) => {
      const d = (e as CustomEvent<PresenceEvent>).detail;
      if (!d || typeof d.user_id !== 'number') return;
      setOnline((prev) => ({ ...prev, [d.user_id]: !!d.online }));
    };
    window.addEventListener('hr:presence', onPresence);
    return () => window.removeEventListener('hr:presence', onPresence);
  }, []);

  const items = useMemo(() => {
    if (!data) return [];
    return [data.general, data.notes, ...data.users].filter((c): c is ConvItem => !!c);
  }, [data]);

  // Ряд ассистента прячется, если поиск явно про людей (легаси-условие).
  const showAssistant = matchesAssistant(q);

  /** Клик по «HR-ассистент» — новый диалог в /chat (легаси openAssistant). */
  const openAssistant = async () => {
    if (aiBusy) return;
    setAiBusy(true);
    setAiError('');
    try {
      const r = await apiPost<{ session_id: string | number }>('/api/dialogues', {});
      router.push(`/chat/${r.session_id}`);
    } catch {
      setAiError('Не удалось открыть диалог с ассистентом');
    } finally {
      setAiBusy(false);
    }
  };

  const pick = (c: ConvItem) => {
    const conv = convOf(c);
    try {
      localStorage.setItem(
        'mpLastConv',
        JSON.stringify({
          key: conv.key,
          peer_key: conv.key,
          general: conv.general,
          is_general: conv.general,
          name: conv.name,
          initials: conv.initials,
          position: conv.position,
        })
      );
    } catch {
      /* приватный режим */
    }
    onSelect(conv);
  };

  return (
    <aside className="flex-1 min-h-0 bg-white border border-gray-100 rounded-2xl shadow-sm flex flex-col overflow-hidden">
      {/* data-msgr-head — за шапку тащится плавающая панель мессенджера.
          Метка стоит на всём блоке, а не на одной строке заголовка: иначе
          зона захвата — полоска в пару сантиметров, и попасть в неё трудно.
          Поле поиска и кнопки внутри исключены самим обработчиком
          (widget.tsx: closest('button, a, input, textarea, select')). */}
      <div data-msgr-head className="p-4 border-b border-gray-50 flex flex-col gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-[#2563eb] rounded-xl flex items-center justify-center text-white shrink-0">
            <MessagesSquare size={16} />
          </div>
          <h1 className="font-bold text-sm text-[#0f1c3f]">Мессенджер</h1>
          {headerExtra && <div className="ml-auto flex items-center gap-1">{headerExtra}</div>}
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по сотрудникам…"
            className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-slate-600 focus:outline-none focus:border-[#2563eb] focus:bg-white transition"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {error && (
          <p className="text-xs font-semibold text-red-500 px-2 py-4 text-center">{error}</p>
        )}
        {!error && !data && (
          <p className="text-center text-gray-400 text-xs py-10">Загрузка…</p>
        )}
        {!error && data && items.length === 0 && !showAssistant && (
          <p className="text-center text-gray-400 text-xs py-10">Никого не найдено</p>
        )}

        {/* «HR-ассистент» — всегда первым (легаси messenger_page.js:141) */}
        {showAssistant && (
          <button
            onClick={openAssistant}
            disabled={aiBusy}
            className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl transition text-left hover:bg-gray-50 disabled:opacity-50"
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white bg-[#2563eb] shrink-0">
              <Bot size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-700 truncate">HR-ассистент</p>
              <p
                className={`text-xs truncate ${aiError ? 'text-red-500 font-semibold' : 'text-gray-400'}`}
              >
                {aiError || (aiBusy ? 'Открываю диалог…' : 'Задать вопрос в новом диалоге')}
              </p>
            </div>
          </button>
        )}

        {items.map((c) => {
          const isActive = active?.key === c.key;
          const isOnline = c.peer_id != null && !c.is_notes && online[c.peer_id];
          return (
            <button
              key={c.key}
              onClick={() => pick(c)}
              className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl transition text-left ${
                isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
              }`}
            >
              <div className="relative shrink-0">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-xs ${avatarStyle(c)}`}
                >
                  {c.initials || '?'}
                </div>
                {isOnline && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-white rounded-full"
                    title="В сети"
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm font-semibold truncate ${
                    isActive ? 'text-[#2563eb]' : 'text-slate-700'
                  }`}
                >
                  {c.name}
                </p>
                <p className="text-xs text-gray-400 truncate">{c.last_text || c.position}</p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                {c.last_at && (
                  <span className="text-[10px] text-gray-400">{timeAgo(utcIso(c.last_at))}</span>
                )}
                {c.unread > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 bg-[#2563eb] text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {c.unread > 99 ? '99+' : c.unread}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
