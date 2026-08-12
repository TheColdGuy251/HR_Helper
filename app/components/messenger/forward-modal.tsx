'use client';
import { useEffect, useMemo, useState } from 'react';
import { Bot, Search, Share2, X } from 'lucide-react';
import { apiGet } from '@/lib/api';
import type { ConvItem, ConversationsData } from './types';
import { matchesAssistant } from './types';

// Модалка выбора беседы для пересылки (порт диалога пересылки из messenger.js).
// Список — GET /api/messenger/conversations?q=, отправка — на стороне вызывающего:
// POST /api/messenger/send с forward_user_message_id / forward_message_id.
// Первым в списке — «HR-ассистент» (легаси assistantRow в режиме пересылки,
// messenger.js:415-451): пересылка уходит в POST /api/messenger/forward-to-assistant.

const SEARCH_DEBOUNCE = 220;

/** Куда пересылаем: общий чат или личный диалог. */
export interface ForwardTarget {
  general: boolean;
  peerId: number | null;
  name: string;
}

function avatarStyle(c: ConvItem): string {
  if (c.key === 'general') return 'bg-[#2563eb]';
  if (c.is_notes) return 'bg-amber-400';
  return 'bg-[#0f1c3f]';
}

export function ForwardModal({
  count,
  busy,
  error,
  onPick,
  onAssistant,
  onClose,
}: {
  count: number;
  busy?: boolean;
  error?: string;
  onPick: (t: ForwardTarget) => void;
  /** Строка «HR-ассистент» — как в легаси (assistantRow в messenger.js). */
  onAssistant?: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [data, setData] = useState<ConversationsData | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      apiGet<ConversationsData>(`/api/messenger/conversations?q=${encodeURIComponent(q)}`)
        .then((d) => {
          if (alive) {
            setData(d);
            setLoadError('');
          }
        })
        .catch((e) => {
          if (alive) setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить беседы');
        });
    }, data ? SEARCH_DEBOUNCE : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // data намеренно не в зависимостях: нужен только флаг «первая загрузка».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = useMemo(() => {
    if (!data) return [];
    return [data.general, data.notes, ...data.users].filter((c): c is ConvItem => !!c);
  }, [data]);

  return (
    <div
      className="fixed inset-0 z-[96] bg-black/30 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-gray-100 rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[80vh] overflow-hidden">
        <div className="p-4 border-b border-gray-50 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-bold text-sm text-[#0f1c3f] min-w-0">
            <Share2 size={16} className="text-[#2563eb] shrink-0" />
            <span className="truncate">
              Переслать{count > 1 ? ` · ${count}` : ''}
            </span>
          </div>
          <button onClick={onClose} className="p-1 text-gray-300 hover:text-gray-500 transition shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 pt-3">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Кому переслать…"
              className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-slate-600 focus:outline-none focus:border-[#2563eb] focus:bg-white transition"
            />
          </div>
        </div>

        {(error || loadError) && (
          <p className="text-[11px] font-semibold text-red-500 px-4 pt-2">{error || loadError}</p>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          {onAssistant && matchesAssistant(q) && (
            <button
              disabled={busy}
              onClick={onAssistant}
              className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl transition text-left hover:bg-gray-50 disabled:opacity-50"
            >
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white bg-[#2563eb] shrink-0">
                <Bot size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-700 truncate">HR-ассистент</p>
                <p className="text-xs text-gray-400 truncate">Переслать ассистенту и обсудить</p>
              </div>
            </button>
          )}
          {!data && !loadError && <p className="text-center text-gray-400 text-xs py-10">Загрузка…</p>}
          {data && items.length === 0 && !(onAssistant && matchesAssistant(q)) && (
            <p className="text-center text-gray-400 text-xs py-10">Никого не найдено</p>
          )}
          {items.map((c) => (
            <button
              key={c.key}
              disabled={busy}
              onClick={() =>
                onPick({ general: c.key === 'general', peerId: c.peer_id, name: c.name })
              }
              className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl transition text-left hover:bg-gray-50 disabled:opacity-50"
            >
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-[11px] shrink-0 ${avatarStyle(c)}`}
              >
                {c.initials || '?'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-700 truncate">{c.name}</p>
                <p className="text-xs text-gray-400 truncate">{c.position || c.last_text}</p>
              </div>
            </button>
          ))}
        </div>

        {busy && (
          <p className="px-4 py-2 border-t border-gray-50 text-[11px] font-semibold text-[#2563eb]">
            Пересылаю…
          </p>
        )}
      </div>
    </div>
  );
}
