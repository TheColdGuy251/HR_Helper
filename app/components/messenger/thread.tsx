'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  FileText,
  Forward,
  Link2,
  Paperclip,
  Pin,
  Trash2,
  X,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost, formatBytes } from '@/lib/api';
import { useComposerPadding } from '@/lib/viewport';
import { useAuth } from '@/components/auth-context';
import { toast } from '@/components/events';
import { useSourcesModal } from '@/components/sources-modal';
import { Composer } from './composer';
import { FilePreviewModal, fileViewUrl, shouldPreview } from './file-preview';
import { ForwardModal, type ForwardTarget } from './forward-modal';
import { ConfirmDeleteModal, Message, type MessageActions } from './message';
import type {
  ActiveConv,
  AiStreamEvent,
  AttachmentsData,
  DeletedEvent,
  EditedEvent,
  MsgAttachment,
  Msg,
  PinnedEvent,
  PollData,
  PollEvent,
  PollPayload,
  PresenceEvent,
  PresenceInfo,
  ReactionData,
  ReactionEvent,
  ReadEvent,
  ThreadResponse,
  TypingEvent,
} from './types';
import {
  aiQueueLabel,
  aiStatusLabel,
  copyText,
  dayKey,
  dayLabel,
  groupedCopyText,
  groupFlag,
  insertOrdered,
  lastSeenText,
  messageText,
  typingLabel,
} from './types';

// Тред мессенджера: история с подгрузкой вверх, разделители дат, пин-бар,
// presence, «печатает…», вложения диалога и стриминговые ответы ИИ.
// Эндпоинты — HR Helper/routes/messenger.py.

const TYPING_TTL = 6000;   // сколько считаем собеседника печатающим
const TICK_MS = 2500;      // пересчёт индикатора «печатает…»
const LOAD_MORE_PX = 160;  // порог подгрузки истории при прокрутке вверх

// Выделение протяжкой (порт attachThreadInteractions из messenger_common.js).
const DRAG_OUT_PX = 3;   // выход курсора за границы пузыря → режим выделения
const EDGE = 66;         // зона автоскролла у краёв ленты
const EDGE_SPEED = 16;   // максимальный шаг автоскролла за кадр
const FORWARD_LIMIT = 30; // столько сообщений принимает /forward-to-assistant
// Порог «клик, а не перетаскивание» для шапки — как DRAG_SLOP в widget.tsx
// и `Math.abs(dx) < 4` в легаси (messenger.js:340).
const HEAD_CLICK_SLOP = 4;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Не удалось выполнить действие');

/**
 * Точка прокрутки к разделителю «Новые сообщения» (порт dividerScrollTop,
 * messenger_common.js:1122): линию держим повыше, но два сообщения ДО неё
 * оставляем в кадре — чтобы не терялся контекст разговора.
 */
function dividerScrollTop(divider: HTMLElement): number {
  let anchor = divider;
  let prev: Element | null = divider.previousElementSibling;
  let count = 0;
  while (prev && count < 2) {
    // instanceof здесь нельзя: в PiP-окне узлы из другого realm.
    if (prev.hasAttribute('data-mid')) {
      anchor = prev as HTMLElement;
      count += 1;
    }
    prev = prev.previousElementSibling;
  }
  return Math.max(0, anchor.offsetTop - 8);
}

/**
 * Отступ ленты под композером — только на сенсорных экранах: там композер
 * приподнимается над клавиатурой (useKeyboardInset) и перекрывает последние
 * сообщения. На десктопе он в обычном потоке, и отступ был бы пустой полосой.
 */
function ComposerPadding({
  listRef,
  composerRef,
}: {
  listRef: React.RefObject<HTMLDivElement | null>;
  composerRef: React.RefObject<HTMLDivElement | null>;
}) {
  useComposerPadding(listRef, composerRef);
  useEffect(
    () => () => {
      if (listRef.current) listRef.current.style.paddingBottom = '';
    },
    [listRef]
  );
  return null;
}

// ── Модалка «Вложения диалога» ──────────────────────────────────────────────

type AttTab = 'documents' | 'media' | 'links';

const ATT_TABS: { key: AttTab; label: string }[] = [
  { key: 'documents', label: 'Документы' },
  { key: 'media', label: 'Медиа' },
  { key: 'links', label: 'Ссылки' },
];

function AttachmentsModal({ conv, onClose }: { conv: ActiveConv; onClose: () => void }) {
  const [tab, setTab] = useState<AttTab>('documents');
  const [q, setQ] = useState('');
  const [data, setData] = useState<AttachmentsData | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<MsgAttachment | null>(null);

  useEffect(() => {
    const params = conv.general ? 'general=1' : `peer_id=${conv.peerId}`;
    apiGet<AttachmentsData>(`/api/messenger/attachments?${params}`)
      .then(setData)
      .catch((e) => setError(errMsg(e)));
  }, [conv]);

  const term = q.trim().toLowerCase();
  const docs = (data?.documents || []).filter((a) => !term || a.name.toLowerCase().includes(term));
  const media = data?.media || [];
  const links = (data?.links || []).filter((l) => !term || l.url.toLowerCase().includes(term));
  const counts = {
    documents: data?.documents.length || 0,
    media: data?.media.length || 0,
    links: data?.links.length || 0,
  };

  return (
    <div
      className="fixed inset-0 z-[95] bg-black/30 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-gray-100 rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b border-gray-50 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-sm text-[#0f1c3f]">
            <Paperclip size={16} className="text-[#2563eb]" />
            Вложения диалога
          </div>
          <button onClick={onClose} className="p-1 text-gray-300 hover:text-gray-500 transition">
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-1 px-3 pt-2 border-b border-gray-100 text-xs font-semibold">
          {ATT_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setTab(t.key);
                setQ('');
              }}
              className={`px-3 py-2 border-b-2 transition ${
                tab === t.key
                  ? 'border-[#2563eb] text-[#2563eb]'
                  : 'border-transparent text-gray-400 hover:text-slate-700'
              }`}
            >
              {t.label}
              {counts[t.key] > 0 && ` · ${counts[t.key]}`}
            </button>
          ))}
        </div>

        {tab !== 'media' && (
          <div className="px-4 pt-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск по названию…"
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-slate-600 focus:outline-none focus:border-[#2563eb] focus:bg-white transition"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {error && <p className="text-xs font-semibold text-red-500 text-center py-6">{error}</p>}
          {!error && !data && <p className="text-center text-gray-400 text-xs py-10">Загрузка…</p>}

          {tab === 'documents' &&
            data &&
            (docs.length === 0 ? (
              <p className="text-center text-gray-400 text-xs py-10">Нет документов</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {docs.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl p-2"
                  >
                    <a
                      href={fileViewUrl(a)}
                      target="_blank"
                      rel="noopener"
                      title="Открыть предпросмотр"
                      onClick={(e) => {
                        if (!shouldPreview(e, a)) return;
                        e.preventDefault();
                        setPreview(a);
                      }}
                      className="flex items-center gap-2 flex-1 min-w-0"
                    >
                      <FileText size={16} className="text-[#2563eb] shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs font-semibold text-slate-700 truncate">
                          {a.name}
                        </span>
                        <span className="block text-[10px] text-gray-400">{formatBytes(a.size)}</span>
                      </span>
                    </a>
                    <a
                      href={a.download_url}
                      title="Скачать"
                      className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 transition shrink-0"
                    >
                      <Download size={14} />
                    </a>
                  </div>
                ))}
              </div>
            ))}

          {tab === 'media' &&
            data &&
            (media.length === 0 ? (
              <p className="text-center text-gray-400 text-xs py-10">Нет изображений</p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {media.map((a: MsgAttachment) => (
                  <a
                    key={a.id}
                    href={a.url}
                    target="_blank"
                    rel="noopener"
                    title={a.name}
                    onClick={(e) => {
                      if (!shouldPreview(e, a)) return;
                      e.preventDefault();
                      setPreview(a);
                    }}
                    className="block overflow-hidden rounded-xl bg-gray-50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.url} alt={a.name} loading="lazy" className="w-full h-24 object-cover" />
                  </a>
                ))}
              </div>
            ))}

          {tab === 'links' &&
            data &&
            (links.length === 0 ? (
              <p className="text-center text-gray-400 text-xs py-10">Ссылок нет</p>
            ) : (
              <div className="flex flex-col gap-1">
                {links.map((l) => (
                  <a
                    key={`${l.message_id}-${l.url}`}
                    href={l.url}
                    target="_blank"
                    rel="noopener"
                    className="flex items-center gap-2 px-2 py-2 rounded-xl hover:bg-gray-50 transition text-xs text-[#2563eb] font-medium"
                  >
                    <Link2 size={14} className="shrink-0" />
                    <span className="truncate">{l.url}</span>
                  </a>
                ))}
              </div>
            ))}
        </div>
      </div>

      {preview && <FilePreviewModal att={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

// ── Тред ────────────────────────────────────────────────────────────────────

export function Thread({
  conv,
  onBack,
  compact = false,
  headerExtra,
}: {
  conv: ActiveConv;
  onBack: () => void;
  /** Мини-мессенджер: кнопка «назад» нужна и на десктопе. */
  compact?: boolean;
  headerExtra?: React.ReactNode;
}) {
  const { user } = useAuth();
  const router = useRouter();

  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [dividerId, setDividerId] = useState<number | null>(null); // линия «Новые сообщения»
  const [newCount, setNewCount] = useState(0);                     // бейдж на стрелке «вниз»
  const [atBottom, setAtBottom] = useState(true);
  const [coarse, setCoarse] = useState(false);
  const [reply, setReply] = useState<Msg | null>(null);
  const [typers, setTypers] = useState<Record<number, { name: string; ts: number }>>({});
  const [presence, setPresence] = useState<PresenceInfo | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [, setTick] = useState(0);

  // выделение и пересылка
  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [forward, setForward] = useState<{ ids: number[] } | null>(null);
  const [fwdBusy, setFwdBusy] = useState(false);
  const [fwdError, setFwdError] = useState('');
  const [delMenu, setDelMenu] = useState(false); // открыто окно подтверждения удаления

  // Клик по шапке (аватар/имя) открывает вложения. Панель мессенджера тащится
  // за эту же шапку, поэтому запоминаем точку нажатия и отличаем клик от
  // перетаскивания по тому же порогу, что в widget.tsx (DRAG_SLOP = 4).
  const headPressRef = useRef<{ x: number; y: number } | null>(null);

  const { onSourcesClick, sourcesModal } = useSourcesModal();

  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const newCountRef = useRef(0);                                    // зеркало newCount для SSE
  const stickRef = useRef(false);                                   // доскроллить вниз
  const jumpRef = useRef<number | null>(null);                      // подскочить к сообщению
  const keepRef = useRef<{ top: number; height: number } | null>(null); // удержать позицию
  const tmpRef = useRef(0);
  const meId = user?.id ?? -1;

  // Жест протяжки: стартовые координаты, границы стартового пузыря, режим.
  const dragRef = useRef<{ y: number; top: number; bottom: number; active: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  const clickGuard = useRef(false); // протяжка съедает следующий клик

  const params = conv.general ? 'general=1' : `peer_id=${conv.peerId}`;

  // ── скролл ────────────────────────────────────────────────────────────────
  const nearBottom = () => {
    const el = listRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /** Дочитали до низа — бейдж новых гаснет (порт clearNewBadge). */
  const clearNew = useCallback(() => {
    if (!newCountRef.current) return;
    newCountRef.current = 0;
    setNewCount(0);
  }, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const keep = keepRef.current;
    if (keep) {
      keepRef.current = null;
      el.scrollTop = keep.top + (el.scrollHeight - keep.height);
      return;
    }
    const jump = jumpRef.current;
    if (jump != null) {
      jumpRef.current = null;
      const node = el.querySelector<HTMLElement>(`[data-mid="${jump}"]`);
      if (node) {
        node.scrollIntoView({ block: 'center' });
        // Всё непрочитанное поместилось в кадр — бейдж не нужен.
        if (nearBottom()) clearNew();
        setAtBottom(nearBottom());
        return;
      }
    }
    if (stickRef.current) {
      stickRef.current = false;
      el.scrollTop = el.scrollHeight;
    }
    setAtBottom(nearBottom());
  }, [messages, clearNew]);

  // Сенсорный экран: только там композер уезжает вверх из-под клавиатуры.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const apply = () => setCoarse(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // ── первичная загрузка ────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setLoading(true);
    apiGet<ThreadResponse>(`/api/messenger/thread?${params}`)
      .then((r) => {
        if (!alive) return;
        setMessages(r.messages);
        setHasMore(r.has_more);
        setDividerId(r.first_unread_id);
        // Непрочитанные есть — подскакиваем к линии и показываем их счётчик.
        newCountRef.current = r.first_unread_id ? r.unread_count || 0 : 0;
        setNewCount(newCountRef.current);
        if (r.first_unread_id) jumpRef.current = r.first_unread_id;
        else stickRef.current = true;
        setError('');
      })
      .catch((e) => {
        if (alive) setError(errMsg(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [params]);

  // ── presence собеседника ──────────────────────────────────────────────────
  useEffect(() => {
    if (conv.general || conv.notes || !conv.peerId) return;
    let alive = true;
    apiGet<PresenceInfo>(`/api/messenger/presence?peer_id=${conv.peerId}`)
      .then((p) => {
        if (alive) setPresence(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [conv]);

  // Индикатор «печатает…» гаснет сам — просто перерисовываемся раз в 2.5 с.
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), TICK_MS);
    return () => clearInterval(t);
  }, []);

  // ── отметка прочтения ─────────────────────────────────────────────────────
  const markRead = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const body = conv.general ? { general: true } : { peer_id: conv.peerId };
    apiPost('/api/messenger/read', body).catch(() => {});
  }, [conv]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') markRead();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [markRead]);

  const patch = useCallback((id: number | string, upd: Partial<Msg>) => {
    setMessages((prev) => prev.map((m) => (String(m.id) === String(id) ? { ...m, ...upd } : m)));
  }, []);

  // ── подгрузка истории вверх ───────────────────────────────────────────────
  const loadOlder = useCallback(async () => {
    const el = listRef.current;
    const first = messages.find((m) => typeof m.id === 'number');
    if (!el || !first || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    const snap = { top: el.scrollTop, height: el.scrollHeight };
    try {
      const r = await apiGet<ThreadResponse>(
        `/api/messenger/thread?${params}&before_id=${first.id}`
      );
      keepRef.current = snap;
      setHasMore(!!r.has_more && r.messages.length > 0);
      setMessages((prev) => [...r.messages, ...prev]);
    } catch {
      /* сеть моргнула — попробуем при следующей прокрутке */
    } finally {
      setLoadingOlder(false);
    }
  }, [messages, loadingOlder, hasMore, params]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const nb = nearBottom();
    setAtBottom(nb);
    if (nb) clearNew();
    if (el.scrollTop <= LOAD_MORE_PX) loadOlder();
  };

  /** Стрелка «вниз»: при новых — сначала к разделителю, повторно — в самый низ. */
  const scrollDown = () => {
    const el = listRef.current;
    if (!el) return;
    const divider = el.querySelector<HTMLElement>('[data-new-divider]');
    if (newCount > 0 && divider && divider.offsetTop > el.scrollTop + 8) {
      el.scrollTo({ top: dividerScrollTop(divider), behavior: 'smooth' });
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    clearNew();
  };

  const jumpTo = useCallback((id: number) => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlight(id);
    setTimeout(() => setHighlight((v) => (v === id ? null : v)), 1600);
  }, []);

  // ── выделение сообщений ───────────────────────────────────────────────────
  const exitSelect = useCallback(() => {
    setSelMode(false);
    setSelected(new Set());
    setDelMenu(false);
  }, []);

  const toggleSelect = useCallback((id: number) => {
    if (clickGuard.current) {
      clickGuard.current = false;
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startSelect = useCallback((m: Msg) => {
    if (typeof m.id !== 'number') return;
    setSelMode(true);
    setSelected((prev) => new Set(prev).add(m.id as number));
  }, []);

  // Esc выходит из режима выделения (как в легаси). Пока открыто окно
  // подтверждения удаления, Esc гасит только его.
  useEffect(() => {
    if (!selMode || delMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitSelect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selMode, delMenu, exitSelect]);

  // Тулбар прячется, когда ничего не выбрано (но режим остаётся).
  const selCount = selected.size;

  /** Сообщение под курсором по вертикали — как msgAtY в легаси. */
  const msgAtY = useCallback((y: number): number | null => {
    const nodes = listRef.current?.querySelectorAll<HTMLElement>('[data-selectable]');
    if (!nodes) return null;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) {
        const id = Number(n.getAttribute('data-mid'));
        return Number.isFinite(id) ? id : null;
      }
    }
    return null;
  }, []);

  /** Протяжка только ДОБАВЛЯЕТ в набор — как в легаси. */
  const addAtY = useCallback(
    (y: number) => {
      const id = msgAtY(y);
      if (id == null) return;
      setSelected((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    },
    [msgAtY]
  );

  const stopDrag = useCallback(() => {
    dragRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Отпустить кнопку можно и за пределами ленты — слушаем окно.
  useEffect(() => {
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    return () => {
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      stopDrag();
    };
  }, [stopDrag]);

  // Автоскролл у краёв ленты: скорость линейно растёт к кромке.
  const startAutoScroll = useCallback(() => {
    function step() {
      const d = dragRef.current;
      const el = listRef.current;
      if (!d || !d.active || !el) {
        rafRef.current = null;
        return;
      }
      const r = el.getBoundingClientRect();
      let dy = 0;
      if (d.y < r.top + EDGE) dy = -EDGE_SPEED * Math.min(1, (r.top + EDGE - d.y) / EDGE);
      else if (d.y > r.bottom - EDGE) dy = EDGE_SPEED * Math.min(1, (d.y - (r.bottom - EDGE)) / EDGE);
      if (dy) {
        el.scrollTop += dy;
        addAtY(d.y);
      }
      rafRef.current = requestAnimationFrame(step);
    }
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(step);
  }, [addAtY]);

  const onListPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const node = (e.target as HTMLElement).closest?.('[data-selectable]') as HTMLElement | null;
    if (!node) return;
    if ((e.target as HTMLElement).closest('a, button, textarea, input')) return;
    const r = node.getBoundingClientRect();
    clickGuard.current = false;
    dragRef.current = { y: e.clientY, top: r.top, bottom: r.bottom, active: selMode };
  };

  const onListPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerType !== 'mouse') return;
    d.y = e.clientY;
    if (!d.active) {
      // Выход курсора выше/ниже пузыря включает выделение (внутри — обычное
      // выделение текста).
      if (e.clientY >= d.top - DRAG_OUT_PX && e.clientY <= d.bottom + DRAG_OUT_PX) return;
      d.active = true;
      clickGuard.current = true;
      setSelMode(true);
      window.getSelection()?.removeAllRanges();
      addAtY((d.top + d.bottom) / 2);
    }
    addAtY(e.clientY);
    startAutoScroll();
  };

  // ── действия над выделенным ───────────────────────────────────────────────
  const selectedMsgs = useMemo(
    () => messages.filter((m) => typeof m.id === 'number' && selected.has(m.id)),
    [messages, selected]
  );
  /** id выделенных в порядке ленты — как selectedMsgs() в легаси. */
  const selectedIds = useMemo(
    () => selectedMsgs.map((m) => m.id).filter((v): v is number => typeof v === 'number'),
    [selectedMsgs]
  );

  const copySelected = () => {
    copyText(groupedCopyText(selectedMsgs));
    exitSelect();
    toast({ title: 'Скопировано', body: `Сообщений: ${selCount}` });
  };

  const deleteSelected = async (forAll: boolean) => {
    const list = selectedMsgs;
    exitSelect();
    for (const m of list) {
      if (typeof m.id !== 'number') continue;
      try {
        await apiDelete(`/api/messenger/messages/${m.id}${forAll ? '?for_all=1' : ''}`);
        setMessages((prev) => prev.filter((x) => String(x.id) !== String(m.id)));
      } catch (e) {
        setNotice(errMsg(e));
        break;
      }
    }
  };

  const forwardSelected = () => {
    if (!selectedIds.length) return;
    setFwdError('');
    setForward({ ids: selectedIds });
  };

  /** N последовательных POST /api/messenger/send — сервер принимает по одному id. */
  const doForward = async (target: ForwardTarget) => {
    if (!forward) return;
    setFwdBusy(true);
    setFwdError('');
    const base: Record<string, unknown> = target.general
      ? { general: true }
      : { peer_id: target.peerId };
    const sameConv = target.general ? conv.general : !conv.general && conv.peerId === target.peerId;
    try {
      for (const id of forward.ids) {
        const msg = await apiPost<Msg>('/api/messenger/send', {
          ...base,
          forward_user_message_id: id,
        });
        if (sameConv) {
          stickRef.current = true;
          setMessages((prev) => insertOrdered(prev, msg));
        }
      }
      setForward(null);
      exitSelect();
      toast({
        title: 'Переслано',
        body: `${forward.ids.length} → ${target.name}`,
      });
    } catch (e) {
      setFwdError(errMsg(e));
    } finally {
      setFwdBusy(false);
    }
  };

  /** Пересылка выбранного в новый диалог с ассистентом (лимит бэкенда — 30). */
  const forwardToAssistant = async (ids: number[]) => {
    if (!ids.length) return;
    setFwdBusy(true);
    setFwdError('');
    try {
      const r = await apiPost<{ session_id: string | number }>(
        '/api/messenger/forward-to-assistant',
        { message_ids: ids.slice(0, FORWARD_LIMIT) }
      );
      setForward(null);
      exitSelect();
      router.push(`/chat/${r.session_id}`);
    } catch (e) {
      setFwdError(errMsg(e));
      setNotice(errMsg(e));
    } finally {
      setFwdBusy(false);
    }
  };

  // ── отправка ──────────────────────────────────────────────────────────────
  const send = useCallback(
    async (content: string, list: MsgAttachment[]) => {
      const replyTo = reply;
      setReply(null);
      setNotice('');
      const tmpId = `tmp${(tmpRef.current += 1)}`;
      const optimistic: Msg = {
        id: tmpId,
        sender_id: meId,
        sender_name: 'Вы',
        sender_initials: user?.initials || 'Я',
        content,
        forwarded: false,
        forwarded_meta: null,
        created_at: new Date().toISOString(),
        mine: true,
        peer_key: conv.key,
        is_general: conv.general,
        status: 'sending',
        attachments: list,
        reactions: [],
        poll: null,
        reply_to:
          replyTo && typeof replyTo.id === 'number'
            ? {
                id: replyTo.id,
                sender_name: replyTo.sender_name,
                text: messageText(replyTo).replace(/\n/g, ' ').slice(0, 80),
              }
            : null,
      };
      stickRef.current = true;
      setMessages((prev) => [...prev, optimistic]);

      const body: Record<string, unknown> = { content };
      if (conv.general) body.general = true;
      else body.peer_id = conv.peerId;
      if (replyTo && typeof replyTo.id === 'number') body.reply_to_id = replyTo.id;
      if (list.length) body.attachment_ids = list.map((a) => a.id);

      try {
        const saved = await apiPost<Msg>('/api/messenger/send', body);
        setMessages((prev) => prev.map((m) => (m.id === tmpId ? saved : m)));
      } catch (e) {
        setNotice(errMsg(e));
        setMessages((prev) =>
          prev.map((m) => (m.id === tmpId ? { ...m, status: 'failed' as const } : m))
        );
      }
    },
    [conv, reply, meId, user?.initials]
  );

  const ask = useCallback(
    async (content: string) => {
      setNotice('');
      const body = conv.general
        ? { general: true, content }
        : { peer_id: conv.peerId, content };
      try {
        const r = await apiPost<{ question: Msg }>('/api/messenger/ask', body);
        stickRef.current = true;
        setMessages((prev) => insertOrdered(prev, r.question));
      } catch (e) {
        setNotice(errMsg(e));
      }
    },
    [conv]
  );

  const createPoll = useCallback(
    async (payload: PollPayload) => {
      setNotice('');
      const body: Record<string, unknown> = { ...payload };
      if (conv.general) body.general = true;
      else body.peer_id = conv.peerId;
      try {
        const msg = await apiPost<Msg>('/api/messenger/poll', body);
        stickRef.current = true;
        setMessages((prev) => insertOrdered(prev, msg));
      } catch (e) {
        setNotice(errMsg(e));
      }
    },
    [conv]
  );

  // ── действия над сообщением ───────────────────────────────────────────────
  const actions: MessageActions = useMemo(
    () => ({
      onReply: (m) => setReply(m),
      onEdit: async (id, content) => {
        try {
          await apiPost('/api/messenger/edit', { message_id: id, content });
          patch(id, { content, is_edited: true });
        } catch (e) {
          setNotice(errMsg(e));
        }
      },
      onDelete: async (m, forAll) => {
        if (typeof m.id !== 'number') return;
        try {
          await apiDelete(`/api/messenger/messages/${m.id}${forAll ? '?for_all=1' : ''}`);
          setMessages((prev) => prev.filter((x) => String(x.id) !== String(m.id)));
        } catch (e) {
          setNotice(errMsg(e));
        }
      },
      onPin: async (m) => {
        if (typeof m.id !== 'number') return;
        try {
          await apiPost('/api/messenger/pin', { message_id: m.id, pinned: !m.is_pinned });
        } catch (e) {
          setNotice(errMsg(e));
        }
      },
      onReact: async (id, emoji) => {
        try {
          const r = await apiPost<{ reactions: ReactionData[] }>('/api/messenger/reaction', {
            message_id: id,
            emoji,
          });
          patch(id, { reactions: r.reactions });
        } catch (e) {
          setNotice(errMsg(e));
        }
      },
      onVote: async (m, optionId) => {
        try {
          const r = await apiPost<{ poll: PollData }>('/api/messenger/poll/vote', {
            option_id: optionId,
          });
          patch(m.id, { poll: r.poll });
        } catch (e) {
          setNotice(errMsg(e));
        }
      },
      onForward: (m) => {
        if (typeof m.id !== 'number') return;
        setFwdError('');
        setForward({ ids: [m.id] });
      },
      onJump: jumpTo,
      onStartSelect: startSelect,
      onToggleSelect: toggleSelect,
    }),
    [patch, jumpTo, startSelect, toggleSelect]
  );

  // ── SSE ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const key = conv.key;

    const onMessage = (e: Event) => {
      const m = (e as CustomEvent<Msg>).detail;
      if (!m || m.peer_key !== key) return;
      if (m.mine && !m.system) return; // своё уже показано оптимистично
      const stick = nearBottom();
      setTypers((prev) => {
        if (!(m.sender_id in prev)) return prev;
        const next = { ...prev };
        delete next[m.sender_id];
        return next;
      });
      setMessages((prev) => insertOrdered(prev, m));
      if (stick) {
        stickRef.current = true;
      } else if (!m.mine && !m.system && typeof m.id === 'number') {
        // Читаем историю выше — линия «Новые сообщения» встаёт перед началом
        // свежей партии, счётчик уезжает на стрелку (порт markIncoming).
        if (!newCountRef.current) setDividerId(m.id);
        newCountRef.current += 1;
        setNewCount(newCountRef.current);
      }
      if (!m.mine) markRead();
    };

    const onTyping = (e: Event) => {
      const d = (e as CustomEvent<TypingEvent>).detail;
      if (!d || d.peer_key !== key || d.sender_id === meId) return;
      setTypers((prev) => {
        const next = { ...prev };
        if (d.typing) next[d.sender_id] = { name: d.sender_name, ts: Date.now() };
        else delete next[d.sender_id];
        return next;
      });
    };

    const onDeleted = (e: Event) => {
      const d = (e as CustomEvent<DeletedEvent>).detail;
      if (!d || d.peer_key !== key) return;
      setMessages((prev) => prev.filter((m) => String(m.id) !== String(d.id)));
    };

    const onPinned = (e: Event) => {
      const d = (e as CustomEvent<PinnedEvent>).detail;
      if (!d || d.peer_key !== key) return;
      patch(d.id, { is_pinned: d.pinned });
    };

    const onEdited = (e: Event) => {
      const d = (e as CustomEvent<EditedEvent>).detail;
      if (!d || d.peer_key !== key) return;
      patch(d.id, { content: d.content, is_edited: true });
    };

    const onRead = (e: Event) => {
      const d = (e as CustomEvent<ReadEvent>).detail;
      if (!d || d.peer_key !== key) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.mine && typeof m.id === 'number' && m.id <= d.last_read_id && m.status !== 'seen'
            ? { ...m, status: 'seen' as const }
            : m
        )
      );
    };

    const onReaction = (e: Event) => {
      const d = (e as CustomEvent<ReactionEvent>).detail;
      if (!d || d.peer_key !== key) return;
      patch(d.id, { reactions: d.reactions });
    };

    const onPoll = (e: Event) => {
      const d = (e as CustomEvent<PollEvent>).detail;
      if (!d || d.peer_key !== key) return;
      patch(d.id, { poll: d.poll });
    };

    const onPresence = (e: Event) => {
      const d = (e as CustomEvent<PresenceEvent>).detail;
      if (!d || conv.general || conv.notes || conv.peerId !== d.user_id) return;
      setPresence({ online: !!d.online, last_seen: d.last_seen ?? null });
    };

    // Ответ ИИ приходит потоком: сначала плейсхолдер, затем статусы и текст.
    const onAiStream = (e: Event) => {
      const d = (e as CustomEvent<AiStreamEvent>).detail;
      if (!d || d.peer_key !== key) return;
      const stick = nearBottom();
      setMessages((prev) => {
        let list = prev;
        let idx = list.findIndex((m) => String(m.id) === String(d.id));
        if (idx === -1) {
          const seed: Msg = {
            id: d.id,
            sender_id: d.asker_id,
            sender_name: 'HR-ассистент',
            sender_initials: '🤖',
            content: '',
            forwarded: true,
            forwarded_meta: { content: '', sources: [], ai: true },
            created_at: new Date().toISOString(),
            mine: d.asker_id === meId,
            peer_key: key,
            is_general: conv.general,
            attachments: [],
            reactions: [],
            poll: null,
            streaming: { status: aiStatusLabel(d.status), text: '', sources: [] },
          };
          list = insertOrdered(list, seed);
          idx = list.findIndex((m) => String(m.id) === String(d.id));
        }
        const cur = list[idx];
        const st = cur.streaming || { status: '', text: '', sources: [] };
        let next: Msg;
        if (d.phase === 'done') {
          next = {
            ...cur,
            streaming: null,
            forwarded: true,
            forwarded_meta: {
              content: d.content ?? st.text,
              sources: d.sources ?? st.sources,
              ai: true,
            },
          };
        } else if (d.phase === 'chunk') {
          next = { ...cur, streaming: { ...st, text: st.text + (d.chunk || '') } };
        } else if (d.phase === 'sources') {
          next = { ...cur, streaming: { ...st, sources: d.sources || [] } };
        } else if (d.phase === 'queued') {
          next = {
            ...cur,
            streaming: { ...st, status: aiQueueLabel(d.queue_position, d.queue_total) },
          };
        } else {
          next = { ...cur, streaming: { ...st, status: aiStatusLabel(d.status) } };
        }
        const out = list.slice();
        out[idx] = next;
        return out;
      });
      if (stick) stickRef.current = true;
    };

    const handlers: [string, EventListener][] = [
      ['hr:user-message', onMessage],
      ['hr:user-typing', onTyping],
      ['hr:user-deleted', onDeleted],
      ['hr:user-pinned', onPinned],
      ['hr:user-edited', onEdited],
      ['hr:user-read', onRead],
      ['hr:reaction', onReaction],
      ['hr:poll', onPoll],
      ['hr:presence', onPresence],
      ['hr:ai-stream', onAiStream],
    ];
    handlers.forEach(([n, h]) => window.addEventListener(n, h));
    return () => handlers.forEach(([n, h]) => window.removeEventListener(n, h));
  }, [conv, markRead, meId, patch]);

  // ── производные данные ────────────────────────────────────────────────────
  const pinned = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].is_pinned) return messages[i];
    return null;
  }, [messages]);

  const now = Date.now();
  const activeTypers = Object.values(typers).filter((t) => now - t.ts < TYPING_TTL);

  const subtitle = activeTypers.length
    ? conv.general
      ? typingLabel(activeTypers.map((t) => t.name))
      : 'печатает…'
    : conv.general
      ? 'Все сотрудники'
      : conv.notes
        ? 'Личные заметки и запросы к ИИ'
        : presence
          ? presence.online
            ? 'Онлайн'
            : lastSeenText(presence.last_seen)
          : conv.position;

  const rows = useMemo(() => {
    const out: React.ReactNode[] = [];
    messages.forEach((m, i) => {
      const prev = i > 0 ? messages[i - 1] : undefined;
      const next = messages[i + 1];
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      if (newDay) {
        out.push(
          <div key={`day-${m.id}`} className="flex justify-center my-3">
            <span className="text-[11px] font-semibold text-gray-400 bg-white border border-gray-100 rounded-full px-3 py-1">
              {dayLabel(m.created_at)}
            </span>
          </div>
        );
      }
      if (dividerId != null && m.id === dividerId) {
        out.push(
          <div key={`unread-${m.id}`} data-new-divider className="flex items-center gap-2 my-3">
            <span className="flex-1 h-px bg-blue-100" />
            <span className="text-[11px] font-bold text-[#2563eb]">Новые сообщения</span>
            <span className="flex-1 h-px bg-blue-100" />
          </div>
        );
      }
      const g = groupFlag(prev, m);
      out.push(
        <Message
          key={m.id}
          msg={m}
          general={conv.general}
          grouped={newDay ? false : g.grouped}
          gap={g.gap && !newDay}
          hideAvatar={next ? groupFlag(m, next).grouped : false}
          highlight={highlight != null && String(highlight) === String(m.id)}
          selection={{
            mode: selMode,
            checked: typeof m.id === 'number' && selected.has(m.id),
          }}
          actions={actions}
        />
      );
    });
    return out;
  }, [messages, dividerId, conv.general, highlight, actions, selMode, selected]);

  // «Удалить для всех» доступно, только если ВСЕ выбранные — свои (легаси).
  const allMine = selectedMsgs.every((m) => m.mine && !m.system);

  return (
    <section className="flex-1 bg-white border border-gray-100 rounded-2xl shadow-sm flex flex-col overflow-hidden min-h-0 relative">
      {/* тулбар выделения — поверх шапки, как .msgr-seltools в легаси */}
      {selMode && selCount > 0 && (
        <div className="absolute inset-x-0 top-0 z-30 h-12 px-3 flex items-center gap-2 bg-gradient-to-r from-[#1e40af]/95 to-[#2563eb]/95 backdrop-blur text-white shadow-md">
          <span className="text-xs font-semibold">
            <b>{selCount}</b> выбрано
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={copySelected}
              title="Копировать"
              className="p-2 rounded-lg hover:bg-white/15 transition"
            >
              <Copy size={16} />
            </button>
            <button
              onClick={forwardSelected}
              title="Переслать"
              className="p-2 rounded-lg hover:bg-white/15 transition"
            >
              <Forward size={16} />
            </button>
            {/* отдельной кнопки «переслать ассистенту» в легаси не было:
                ассистент — один из получателей в окне пересылки */}
            {/* одна кнопка «Удалить» → окно выбора, как ctx.toolbar.del в легаси */}
            <button
              onClick={() => setDelMenu(true)}
              title="Удалить"
              className="p-2 rounded-lg hover:bg-white/15 transition"
            >
              <Trash2 size={16} />
            </button>
            <button
              onClick={exitSelect}
              title="Отмена"
              className="p-2 rounded-lg hover:bg-white/15 transition"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* шапка (data-msgr-head — за неё тащится плавающая панель мессенджера) */}
      <div
        data-msgr-head
        className="p-3 md:p-4 border-b border-gray-50 flex items-center gap-3 bg-gray-50/30 shrink-0"
      >
        <button
          onClick={onBack}
          className={`${compact ? '' : 'md:hidden '}p-1.5 rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-white transition shrink-0`}
          title="К списку бесед"
        >
          <ChevronLeft size={18} />
        </button>
        {/* Аватар + имя — клик открывает «Вложения диалога» (messenger.js:810-811,
            messenger_page.js:499-501). Это не <button>: иначе widget.tsx исключит
            область из зоны перетаскивания панели. */}
        <div
          role="button"
          tabIndex={0}
          title="Вложения диалога"
          onMouseDown={(e) => {
            headPressRef.current = { x: e.clientX, y: e.clientY };
          }}
          onClick={(e) => {
            const p = headPressRef.current;
            headPressRef.current = null;
            // Панель тащили этим же движением — клик не засчитываем.
            if (
              p &&
              (Math.abs(e.clientX - p.x) > HEAD_CLICK_SLOP ||
                Math.abs(e.clientY - p.y) > HEAD_CLICK_SLOP)
            ) {
              return;
            }
            setAttachOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            setAttachOpen(true);
          }}
          className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer rounded-xl -mx-1 px-1 py-0.5 hover:bg-white/70 transition"
        >
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-xs shrink-0 ${
              conv.general ? 'bg-[#2563eb]' : conv.notes ? 'bg-amber-400' : 'bg-[#0f1c3f]'
            }`}
          >
            {conv.initials || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-sm text-[#0f1c3f] truncate">{conv.name}</h2>
            <p className="text-[11px] text-gray-400 truncate">{subtitle}</p>
          </div>
        </div>
        {headerExtra}
      </div>

      {/* закреплённое сообщение */}
      {pinned && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50/60 border-b border-blue-100 shrink-0">
          <Pin size={14} className="text-[#2563eb] shrink-0" />
          <button
            onClick={() => typeof pinned.id === 'number' && jumpTo(pinned.id)}
            className="flex-1 min-w-0 text-left"
          >
            <span className="block text-[10px] font-bold text-[#2563eb]">
              Закреплённое сообщение
            </span>
            <span className="block text-[11px] text-slate-600 truncate">
              {messageText(pinned).replace(/\n/g, ' ') || 'Сообщение ассистента'}
            </span>
          </button>
          <button
            onClick={() => actions.onPin(pinned)}
            className="p-1 text-gray-300 hover:text-red-500 transition shrink-0"
            title="Открепить"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* лента */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={listRef}
          onScroll={onScroll}
          onPointerDown={onListPointerDown}
          onPointerMove={onListPointerMove}
          onClick={onSourcesClick}
          className={`relative flex-1 overflow-y-auto px-3 md:px-5 py-4 bg-[#fcfdfe] min-h-0 ${
            selMode ? 'select-none' : ''
          }`}
        >
          {loadingOlder && (
            <p className="text-center text-gray-400 text-xs py-2">Загрузка истории…</p>
          )}
          {loading ? (
            <p className="text-center text-gray-400 text-sm py-10">Загрузка сообщений…</p>
          ) : error ? (
            <p className="text-center text-red-500 text-sm font-semibold py-10">{error}</p>
          ) : messages.length === 0 ? (
            <p className="text-center text-gray-400 text-sm py-10">
              Сообщений пока нет. Напишите первым!
            </p>
          ) : (
            rows
          )}
        </div>

        {/* стрелка «вниз» с бейджем новых сообщений */}
        {!loading && !error && messages.length > 0 && (!atBottom || newCount > 0) && (
          <button
            onClick={scrollDown}
            title={newCount > 0 ? 'К новым сообщениям' : 'Вниз'}
            className="absolute right-4 bottom-4 z-20 w-10 h-10 rounded-full bg-white border border-gray-100 shadow-lg text-[#2563eb] flex items-center justify-center hover:bg-gray-50 transition"
          >
            <ChevronDown size={18} />
            {newCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-[#2563eb] text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white">
                {newCount > 99 ? '99+' : newCount}
              </span>
            )}
          </button>
        )}
      </div>

      {notice && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-100 text-[11px] font-semibold text-red-600 flex items-center justify-between gap-2 shrink-0">
          <span className="truncate">{notice}</span>
          <button onClick={() => setNotice('')} className="p-0.5 shrink-0">
            <X size={12} />
          </button>
        </div>
      )}

      <Composer
        conv={conv}
        reply={reply}
        onCancelReply={() => setReply(null)}
        onSend={send}
        onAsk={ask}
        onPoll={createPoll}
        rootRef={composerRef}
      />
      {coarse && <ComposerPadding listRef={listRef} composerRef={composerRef} />}

      {attachOpen && <AttachmentsModal conv={conv} onClose={() => setAttachOpen(false)} />}

      {delMenu && (
        <ConfirmDeleteModal
          count={selCount}
          allowForAll={allMine}
          onCancel={() => setDelMenu(false)}
          onConfirm={(forAll) => {
            setDelMenu(false);
            void deleteSelected(forAll);
          }}
        />
      )}
      {sourcesModal}

      {forward && (
        <ForwardModal
          count={forward.ids.length}
          busy={fwdBusy}
          error={fwdError}
          onPick={doForward}
          onAssistant={() => forwardToAssistant(forward.ids)}
          onClose={() => {
            setForward(null);
            setFwdError('');
          }}
        />
      )}
    </section>
  );
}
