'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowDown,
  ChevronLeft,
  Copy,
  FileText,
  Forward,
  Loader2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Send,
  Square,
  X,
} from 'lucide-react';
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiUpload,
  formatBytes,
  postSSE,
  type SSEStreamHandle,
} from '@/lib/api';
import { MessageBubble, type ChatMeta, type ChatMsg } from '@/components/chat/message';
import { FaqPicker } from '@/components/chat/faq-picker';
import { ForwardModal, type ForwardTarget } from '@/components/messenger/forward-modal';
import { useSourcesModal } from '@/components/sources-modal';
import { toast } from '@/components/events';
import { clearPendingGen, recordPendingGen } from '@/components/pending-generations';
import { ErrorCallout } from '@/components/ui';
import { useComposerPadding, useKeyboardInset } from '@/lib/viewport';
import type { MessageAttachment, MessageSource } from '@/lib/msgfmt';

// Чат-сессия с ИИ-ассистентом: слева список диалогов, справа лента + композер.
// Порт static/js/chat.js; формы запросов/ответов — routes/chat.py и routes/dialogues.py.

const DEFAULT_TITLE = 'Новый диалог';
const SB_PAGE = 30;      // шаг «Показать ещё» в списке диалогов
const SB_MAX = 100;      // page_size на бэкенде ограничен сотней

const SB_FILTERS: { key: 'active' | 'finished' | 'all'; label: string }[] = [
  { key: 'active', label: 'Активные' },
  { key: 'finished', label: 'Решённые' },
  { key: 'all', label: 'Все' },
];
const ACCEPT =
  '.pdf,.docx,.doc,.txt,.md,.csv,.rtf,.odt,.xls,.xlsx,.xlsm,.ods,.pptx,.ppt,.odp,.zip';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Неизвестная ошибка');

/** Непрочитанные из ответа сервера: завершённые ответы ассистента с is_read=false. */
function unreadOf(list: ChatMsg[]): Set<number> {
  return new Set(
    list
      .filter((m) => m.role === 'assistant' && m.is_read === false && m.is_finished)
      .map((m) => m.id)
      .filter((id): id is number => typeof id === 'number')
  );
}

/** Текст выделенных сообщений с группировкой по автору (порт groupedCopyText). */
function groupedChatText(list: ChatMsg[]): string {
  const groups: { name: string; lines: string[] }[] = [];
  list.forEach((m) => {
    const text = (m.content || '').trim();
    if (!text) return;
    const name = m.role === 'user' ? 'Вы' : 'HR-ассистент';
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.lines.push(text);
    else groups.push({ name, lines: [text] });
  });
  return groups.map((g) => `${g.name}:\n${g.lines.join('\n')}`).join('\n\n');
}

// ── Формы ответов бэкенда ───────────────────────────────────────────────────

interface DialogueItem {
  id: number;
  title: string;
  is_finished: boolean;
  last_activity: string;
  session_id: string | null;
  last_message: { role: string; text: string; ts: string | null } | null;
  unread: boolean;
}

interface DialoguesResponse {
  success: boolean;
  items: DialogueItem[];
  total: number;
  total_pages: number;
}

interface MessagesResponse {
  success: boolean;
  messages: ChatMsg[];
  unread_count: number;
}

interface ActiveResponse {
  success: boolean;
  active: { message_id: number; content: string; last_seq: number; started_at: string }[];
}

interface SessionFile {
  id: number;
  name: string;
  size: number;
  chars: number;
}

/** Строка статуса загрузки файла (порт .upload-status из chat.html). */
interface UploadState {
  text: string;
  percent: number;
  tone: 'busy' | 'success' | 'error';
}

/** Кадры SSE из POST /api/chat/stream (см. chat.py: event_source, _build_done_payload). */
interface StreamFrame {
  initial?: boolean;
  initial_chunk?: string;
  message_id?: number;
  user_message_id?: number;
  last_seq?: number;
  status?: string;
  queue_position?: number;
  queue_total?: number;
  sources?: MessageSource[];
  seq?: number;
  chunk?: string;
  error?: string;
  done?: boolean;
  content?: string;
  meta?: ChatMeta;
  attachment?: MessageAttachment;
  variant_index?: number;
  variant_count?: number;
}

interface StreamCtx {
  handle: SSEStreamHandle | null;
  slot: ChatMsg['id']; // id пузыря, в который пишем (временный до ответа сервера)
  assistantId: number | null;
  lastSeq: number;
  userSlot: ChatMsg['id'] | null; // временный пузырь пользователя
}

export default function ChatSessionPage() {
  const router = useRouter();
  const { id: sessionId } = useParams<{ id: string }>();

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [dialogues, setDialogues] = useState<DialogueItem[]>([]);
  const [dialogueId, setDialogueId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [titleStatus, setTitleStatus] = useState('');
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<SessionFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null); // строка прогресса загрузки
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false); // сайдбар свёрнут (только десктоп)
  const [atBottom, setAtBottom] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  // Непрочитанные ответы ассистента (id). Порт unreadMessages из chat.js.
  const [unreadIds, setUnreadIds] = useState<Set<number>>(() => new Set());

  // выделение сообщений и пересылка в мессенджер (порт #chatSelTools)
  // сайдбар: поиск, фильтр и постраничное «Показать ещё» (порт chat.js initChatSidebar)
  const [sbQuery, setSbQuery] = useState('');
  const [sbFilter, setSbFilter] = useState<'active' | 'finished' | 'all'>('all');
  const [sbLimit, setSbLimit] = useState(SB_PAGE);
  const [sbTotal, setSbTotal] = useState(0);

  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState<Set<ChatMsg['id']>>(() => new Set());
  const [forward, setForward] = useState<{ text?: string; snapshotId?: number; count: number } | null>(
    null
  );
  const [fwdBusy, setFwdBusy] = useState(false);
  const [fwdError, setFwdError] = useState('');

  const { onSourcesClick, sourcesModal } = useSourcesModal();

  const streamRef = useRef<StreamCtx>({
    handle: null,
    slot: '',
    assistantId: null,
    lastSeq: 0,
    userSlot: null,
  });
  const busyRef = useRef(false);
  const dialogueIdRef = useRef<number | null>(null);
  const titleRef = useRef('');
  const titleDirtyRef = useRef(false); // пользователь правил название сам
  const autoTitleRef = useRef(false);
  const lastSyncRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true); // то же, что atBottom: читают колбэки стрима
  const unreadRef = useRef<Set<number>>(new Set());
  const visTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSrvTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upCreepTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const upHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draftKey = sessionId ? `hr_chat_draft_${sessionId}` : '';

  // ── Утилиты состояния ─────────────────────────────────────────────────────

  const patchMsg = useCallback(
    (id: ChatMsg['id'], patch: Partial<ChatMsg> | ((m: ChatMsg) => Partial<ChatMsg>)) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m))
      );
    },
    []
  );

  const setStreaming = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);

  // atBottom дублируем в ref: его читают колбэки стрима, созданные раньше.
  const markAtBottom = useCallback((v: boolean) => {
    atBottomRef.current = v;
    setAtBottom(v);
  }, []);

  const applyUnread = useCallback((next: Set<number>) => {
    unreadRef.current = next;
    setUnreadIds(next);
  }, []);

  const addUnread = useCallback(
    (id: number) => {
      if (unreadRef.current.has(id)) return;
      applyUnread(new Set(unreadRef.current).add(id));
    },
    [applyUnread]
  );

  const dropUnread = useCallback(
    (ids: number[]) => {
      if (!ids.some((i) => unreadRef.current.has(i))) return;
      const next = new Set(unreadRef.current);
      ids.forEach((i) => next.delete(i));
      applyUnread(next);
    },
    [applyUnread]
  );

  const scrollToBottom = useCallback(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const goBottom = useCallback(() => {
    markAtBottom(true);
    scrollToBottom();
  }, [markAtBottom, scrollToBottom]);

  // Мобильная клавиатура: поднимаем композер и держим отступ ленты под ним.
  useKeyboardInset(composerRef);
  useComposerPadding(feedRef, composerRef);

  // Автоскролл — только если пользователь уже внизу ленты.
  useEffect(() => {
    if (atBottom) scrollToBottom();
  }, [messages, atBottom, scrollToBottom]);

  // Свёрнутость сайдбара запоминаем между заходами (порт setCollapsed из chat.js).
  useEffect(() => {
    try {
      if (localStorage.getItem('chatSidebarCollapsed') === '1') setCollapsed(true);
    } catch {
      /* приватный режим */
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem('chatSidebarCollapsed', next ? '1' : '0');
      } catch {
        /* приватный режим */
      }
      return next;
    });
  }, []);

  // Авто-высота поля ввода.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // ── Название диалога ──────────────────────────────────────────────────────

  const applyTitle = useCallback((value: string) => {
    if (titleDirtyRef.current) return; // не затираем то, что печатает пользователь
    const t = value === DEFAULT_TITLE ? '' : value || '';
    titleRef.current = t;
    setTitle(t);
    if (t && typeof document !== 'undefined') document.title = t;
  }, []);

  const onTitleChange = (value: string) => {
    titleDirtyRef.current = true;
    titleRef.current = value;
    setTitle(value);
    setTitleStatus('набираю…');
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(async () => {
      const dlg = dialogueIdRef.current;
      if (!dlg) return;
      try {
        await apiPatch(`/api/dialogues/${dlg}`, { title: value.trim() });
        setTitleStatus('сохранено');
        setTimeout(() => setTitleStatus(''), 1500);
      } catch {
        setTitleStatus('не сохранилось');
      }
    }, 600);
  };

  // Название от ИИ запрашиваем один раз — после первого ответа, если своего нет.
  const requestAutoTitle = useCallback(() => {
    if (autoTitleRef.current) return;
    const dlg = dialogueIdRef.current;
    if (!dlg || titleRef.current.trim()) return;
    autoTitleRef.current = true;
    apiPost(`/api/dialogues/${dlg}/auto-title`).catch(() => {});
  }, []);

  // ── Черновик: localStorage + серверный draft (диалог не «пустой») ──────────

  const clearDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (draftSrvTimer.current) clearTimeout(draftSrvTimer.current);
    if (draftKey) {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* приватный режим */
      }
    }
    const dlg = dialogueIdRef.current;
    if (dlg) apiPatch(`/api/dialogues/${dlg}`, { draft: '' }).catch(() => {});
  }, [draftKey]);

  const onInputChange = (value: string) => {
    setInput(value);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      if (!draftKey) return;
      try {
        if (value.trim()) localStorage.setItem(draftKey, value);
        else localStorage.removeItem(draftKey);
      } catch {
        /* приватный режим */
      }
    }, 200);
    if (draftSrvTimer.current) clearTimeout(draftSrvTimer.current);
    draftSrvTimer.current = setTimeout(() => {
      const dlg = dialogueIdRef.current;
      if (dlg) apiPatch(`/api/dialogues/${dlg}`, { draft: value.trim() }).catch(() => {});
    }, 700);
  };

  // ── Список диалогов (сайдбар) + поиск текущего диалога по session_id ───────

  const loadSidebar = useCallback(async () => {
    try {
      const p = new URLSearchParams({
        filter: sbFilter,
        page: '1',
        page_size: String(sbLimit),
      });
      const q = sbQuery.trim();
      if (q) p.set('search', q);
      const data = await apiGet<DialoguesResponse>(`/api/dialogues?${p.toString()}`);
      setDialogues(data.items || []);
      setSbTotal(data.total || 0);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [sbFilter, sbQuery, sbLimit]);

  // Текущий диалог ищем отдельно: под фильтр/поиск сайдбара он может не попасть.
  const resolveCurrent = useCallback(async () => {
    if (!sessionId) return;
    try {
      for (let page = 1; page <= 6; page++) {
        const data = await apiGet<DialoguesResponse>(
          `/api/dialogues?filter=all&page=${page}&page_size=100`
        );
        const current = (data.items || []).find((d) => d.session_id === sessionId);
        if (current) {
          dialogueIdRef.current = current.id;
          setDialogueId(current.id);
          applyTitle(current.title);
          return;
        }
        if (page >= (data.total_pages || 1)) return;
      }
    } catch {
      /* название и id подтянутся при следующем обновлении */
    }
  }, [sessionId, applyTitle]);

  // Поиск/смена фильтра — с общим debounce, как в легаси (250 мс).
  useEffect(() => {
    const t = setTimeout(() => void loadSidebar(), 250);
    return () => clearTimeout(t);
  }, [loadSidebar]);

  useEffect(() => {
    void resolveCurrent();
  }, [resolveCurrent]);

  // Push-события: авто-название приходит как dialogue_title, остальное — обновление списка.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ type?: string; dialogue_id?: number; title?: string }>).detail;
      if (d?.type === 'dialogue_title' && String(d.dialogue_id) === String(dialogueIdRef.current)) {
        applyTitle(d.title || '');
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadSidebar(), 400);
    };
    window.addEventListener('hr:dialogues-changed', onChanged);
    window.addEventListener('hr:unread-changed', onChanged);
    const interval = setInterval(() => {
      if (!document.hidden) void loadSidebar();
    }, 120000);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener('hr:dialogues-changed', onChanged);
      window.removeEventListener('hr:unread-changed', onChanged);
    };
  }, [loadSidebar, applyTitle]);

  // ── Вложения сессии ───────────────────────────────────────────────────────

  const loadFiles = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await apiGet<{ items: SessionFile[] }>(
        `/api/chat/session-files?session_id=${encodeURIComponent(sessionId)}`
      );
      setFiles(data.items || []);
    } catch {
      /* не критично для работы чата */
    }
  }, [sessionId]);

  /** Останавливает «ползущий» прогресс и таймер автоскрытия строки статуса. */
  const stopUploadTimers = useCallback(() => {
    if (upCreepTimer.current) clearInterval(upCreepTimer.current);
    if (upHideTimer.current) clearTimeout(upHideTimer.current);
    upCreepTimer.current = null;
    upHideTimer.current = null;
  }, []);

  // Порт uploadDocument/uploadFilesSeq из chat.js: строка статуса + полоса прогресса.
  // fetch не отдаёт событий отправки тела, поэтому полосу двигаем по этапам, как в
  // легаси (15% → ожидание → 100%), а во время ожидания ответа она плавно ползёт.
  const uploadFiles = useCallback(
    async (list: FileList | File[]) => {
      const arr = Array.from(list);
      if (!arr.length || !sessionId) return;
      stopUploadTimers();
      setUploading(true);
      let failed = false;

      for (let i = 0; i < arr.length; i++) {
        const file = arr[i];
        const step = arr.length > 1 ? `(${i + 1}/${arr.length}) ` : '';
        setUpload({ text: `${step}Парсинг «${file.name}»…`, percent: 15, tone: 'busy' });

        // Ползём к 85 %, пока ждём ответ; после 1.2 с меняем подпись на «Обработка…».
        let waited = 0;
        upCreepTimer.current = setInterval(() => {
          waited += 400;
          setUpload((s) =>
            s && s.tone === 'busy'
              ? {
                  ...s,
                  percent: Math.min(85, s.percent + 6),
                  text: waited >= 1200 ? `${step}Обработка документа…` : s.text,
                }
              : s
          );
        }, 400);

        const fd = new FormData();
        fd.append('session_id', sessionId);
        fd.append('file', file);
        try {
          const data = await apiUpload<{ file?: { chars?: number } }>(
            '/api/chat/upload-document',
            fd
          );
          const chars = data?.file?.chars;
          setUpload({
            text: `✓ «${file.name}» прикреплён к следующему сообщению${
              chars ? ` (${chars} символов)` : ''
            }.`,
            percent: 100,
            tone: 'success',
          });
          setError(null);
        } catch (e) {
          failed = true;
          setUpload({ text: `Ошибка: ${errMsg(e)}`, percent: 100, tone: 'error' });
          setError(errMsg(e));
        } finally {
          if (upCreepTimer.current) clearInterval(upCreepTimer.current);
          upCreepTimer.current = null;
        }
      }

      setUploading(false);
      await loadFiles();
      // Успех прячем через 3 с, ошибку — через 5 с (как в легаси).
      if (upHideTimer.current) clearTimeout(upHideTimer.current);
      upHideTimer.current = setTimeout(() => setUpload(null), failed ? 5000 : 3000);
    },
    [sessionId, loadFiles, stopUploadTimers]
  );

  useEffect(() => stopUploadTimers, [stopUploadTimers]);

  const removeFile = async (fileId: number) => {
    const prev = files;
    setFiles((list) => list.filter((f) => f.id !== fileId));
    try {
      await apiDelete(`/api/chat/session-files/${fileId}`);
    } catch (e) {
      setFiles(prev);
      setError(errMsg(e));
    }
  };

  // ── История сообщений ─────────────────────────────────────────────────────

  const loadMessages = useCallback(async () => {
    if (!sessionId) return;
    const data = await apiGet<MessagesResponse>(
      `/api/chat/messages?session_id=${encodeURIComponent(sessionId)}&mark_as_read=true`
    );
    const list = data.messages || [];
    setMessages(list);
    // Сервер уже пометил их прочитанными в БД, но в выдаче отдал прежний is_read —
    // по нему и восстанавливаем локальный счётчик.
    applyUnread(unreadOf(list));
  }, [sessionId, applyUnread]);

  const markRead = useCallback(
    (ids: number[]) => {
      if (!ids.length || !sessionId) return;
      apiPost('/api/chat/mark-as-read', { session_id: sessionId, message_ids: ids }).catch(() => {});
    },
    [sessionId]
  );

  // ── Непрочитанные: автопометка по видимости (порт checkVisibleMessages) ────

  /** Помечаем прочитанными непрочитанные ответы, попавшие в видимую часть ленты. */
  const checkVisible = useCallback(() => {
    const el = feedRef.current;
    if (!el || document.hidden || !unreadRef.current.size) return;
    const box = el.getBoundingClientRect();
    const seen: number[] = [];
    el.querySelectorAll<HTMLElement>('[data-role="assistant"][data-message-id]').forEach((node) => {
      const id = Number(node.dataset.messageId);
      if (!Number.isFinite(id) || !unreadRef.current.has(id)) return;
      const r = node.getBoundingClientRect();
      // Целиком в контейнере — либо (длинный ответ) сам закрывает его собой.
      const fits = r.top >= box.top - 4 && r.bottom <= box.bottom + 4;
      const fills = r.height > box.height && r.top <= box.top && r.bottom >= box.bottom;
      if (fits || fills) seen.push(id);
    });
    if (!seen.length) return;
    dropUnread(seen);
    markRead(seen);
  }, [dropUnread, markRead]);

  const scheduleVisible = useCallback(
    (delay = 150) => {
      if (visTimer.current) clearTimeout(visTimer.current);
      visTimer.current = setTimeout(() => {
        visTimer.current = null;
        checkVisible();
      }, delay);
    },
    [checkVisible]
  );

  // Состав ленты (без учёта дописываемого текста) — по нему пересоздаём observer,
  // иначе он перезапускался бы на каждом чанке стрима.
  const feedKey = useMemo(() => messages.map((m) => m.id).join(','), [messages]);

  // Автопометка прочитанного по видимости: IntersectionObserver вместо
  // поллинга/пересчёта прямоугольников на каждый скролл (порт checkVisibleMessages).
  useEffect(() => {
    const root = feedRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') {
      scheduleVisible(60); // старый путь для окружений без IO
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (document.hidden) return;
        const seen: number[] = [];
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.messageId);
          if (!entry.isIntersecting || !Number.isFinite(id) || !unreadRef.current.has(id)) continue;
          const rootHeight = entry.rootBounds?.height ?? 0;
          // Виден целиком — либо (длинный ответ) сам закрывает собой всю ленту.
          const fits = entry.intersectionRatio >= 0.95;
          const fills = rootHeight > 0 && entry.intersectionRect.height >= rootHeight - 8;
          if (fits || fills) seen.push(id);
        }
        if (!seen.length) return;
        dropUnread(seen);
        markRead(seen);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 0.95, 1] }
    );
    root
      .querySelectorAll<HTMLElement>('[data-role="assistant"][data-message-id]')
      .forEach((node) => io.observe(node));
    return () => io.disconnect();
  }, [feedKey, dropUnread, markRead, scheduleVisible]);

  useEffect(() => {
    const onFocus = () => checkVisible();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [checkVisible]);

  useEffect(
    () => () => {
      if (visTimer.current) clearTimeout(visTimer.current);
      if (hlTimer.current) clearTimeout(hlTimer.current);
    },
    []
  );

  /** Прокрутка к первому непрочитанному с короткой подсветкой (порт scrollToFirstUnread). */
  const scrollToFirstUnread = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    const node = Array.from(
      el.querySelectorAll<HTMLElement>('[data-role="assistant"][data-message-id]')
    ).find((n) => unreadRef.current.has(Number(n.dataset.messageId)));
    if (!node) {
      goBottom();
      return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Мягкая янтарная подсветка на 2 секунды (в легаси — rgba(255,215,0,.2)).
    node.style.transition = 'background-color .25s ease';
    node.style.borderRadius = '12px';
    node.style.backgroundColor = 'rgba(253, 230, 138, 0.45)';
    if (hlTimer.current) clearTimeout(hlTimer.current);
    hlTimer.current = setTimeout(() => {
      node.style.backgroundColor = '';
      node.style.borderRadius = '';
      node.style.transition = '';
    }, 2000);
    scheduleVisible(700); // после плавной прокрутки — пометить прочитанным
  }, [goBottom, scheduleVisible]);

  // ── Стриминг ответа ───────────────────────────────────────────────────────

  const endStream = useCallback(() => {
    streamRef.current.handle = null;
    streamRef.current.userSlot = null;
    setStreaming(false);
  }, [setStreaming]);

  const runStream = useCallback(
    (body: Record<string, unknown>, slot: ChatMsg['id'], userSlot: ChatMsg['id'] | null) => {
      const st = streamRef.current;
      st.handle?.abort();
      st.slot = slot;
      st.userSlot = userSlot;
      st.lastSeq = typeof body.last_seq === 'number' ? body.last_seq : 0;
      st.assistantId = typeof body.assistant_message_id === 'number' ? body.assistant_message_id : null;
      setStreaming(true);

      const onFrame = (raw: Record<string, unknown>) => {
        const f = raw as StreamFrame;

        // Временный id пузыря заменяем на настоящий, как только сервер его прислал.
        if (typeof f.message_id === 'number' && st.assistantId !== f.message_id) {
          const real = f.message_id;
          const old = st.slot;
          st.assistantId = real;
          st.slot = real;
          setMessages((prev) => prev.map((m) => (m.id === old ? { ...m, id: real } : m)));
        }
        if (typeof f.user_message_id === 'number' && st.userSlot != null) {
          const old = st.userSlot;
          const real = f.user_message_id;
          st.userSlot = null;
          setMessages((prev) => prev.map((m) => (m.id === old ? { ...m, id: real } : m)));
        }

        // Статус конвейера: очередь / поиск / реранкинг / генерация.
        if (f.status) {
          patchMsg(st.slot, {
            status: f.status,
            queue_position: f.queue_position,
            queue_total: f.queue_total,
          });
        }
        if (f.sources) patchMsg(st.slot, { sources: f.sources });

        // Снимок для возобновления/поздней подписки — заменяет текст, а не дополняет.
        if (f.initial) {
          const text = f.initial_chunk || '';
          patchMsg(st.slot, (m) => (text || !m.content ? { content: text } : {}));
          st.lastSeq = Number(f.last_seq || 0);
          return;
        }

        if (f.error) {
          patchMsg(st.slot, { content: `Ошибка: ${f.error}`, streaming: false, is_finished: true });
          endStream();
          return;
        }

        if (typeof f.seq === 'number') {
          if (f.seq <= st.lastSeq) return; // дедуп повторной доставки
          st.lastSeq = f.seq;
          const chunk = f.chunk || '';
          patchMsg(st.slot, (m) => ({ content: m.content + chunk }));
          return;
        }

        if (f.done) {
          const finishedId = st.assistantId;
          // Ответ считается прочитанным, только если пользователь был внизу ленты
          // и вкладка активна; иначе он пополняет счётчик непрочитанных.
          const seen = atBottomRef.current && !document.hidden;
          patchMsg(st.slot, (m) => ({
            content: typeof f.content === 'string' && f.content ? f.content : m.content,
            sources: f.sources ?? m.sources,
            meta: f.meta ?? m.meta,
            attachment: f.attachment ?? m.attachment,
            variant_index: f.variant_index ?? m.variant_index,
            variant_count: f.variant_count ?? m.variant_count,
            streaming: false,
            is_finished: true,
            is_read: seen,
            ts: new Date().toISOString(),
          }));
          endStream();
          if (finishedId) {
            if (seen) markRead([finishedId]);
            else addUnread(finishedId);
          }
          requestAutoTitle();
          // Пользователь на странице — глобальный тост «Ответ готов» не нужен.
          if (sessionId) clearPendingGen(sessionId);
        }
      };

      // Если уйдём со страницы — тост о завершении покажет глобальный поллер.
      if (sessionId) recordPendingGen(sessionId, dialogueIdRef.current, titleRef.current);

      const handle = postSSE('/api/chat/stream', body, onFrame, (err) => {
        setError(err.message);
        patchMsg(st.slot, (m) => ({
          content: m.content || '(Ошибка генерации)',
          streaming: false,
          is_finished: true,
        }));
        endStream();
      });
      st.handle = handle;

      // Поток закрылся без кадра done (обрыв соединения) — снимаем индикатор.
      handle.done.then(() => {
        if (streamRef.current.handle !== handle) return;
        patchMsg(streamRef.current.slot, { streaming: false });
        endStream();
      });
    },
    [patchMsg, setStreaming, endStream, markRead, addUnread, requestAutoTitle, sessionId]
  );

  const stopStream = useCallback(async () => {
    const st = streamRef.current;
    if (st.assistantId) {
      // Сервер прервёт генерацию и пришлёт done с уже написанной частью.
      try {
        await apiPost('/api/chat/stream/abort', {
          session_id: sessionId,
          assistant_message_id: st.assistantId,
        });
      } catch (e) {
        setError(errMsg(e));
      }
    } else {
      st.handle?.abort();
      patchMsg(st.slot, { streaming: false, is_finished: true });
      endStream();
    }
  }, [sessionId, patchMsg, endStream]);

  // ── Загрузка сессии: история + возобновление активной генерации ────────────

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    // Сброс состояния при переходе в другую сессию.
    streamRef.current.handle?.abort();
    streamRef.current = { handle: null, slot: '', assistantId: null, lastSeq: 0, userSlot: null };
    busyRef.current = false;
    setBusy(false);
    setMessages([]);
    setFiles([]);
    setError(null);
    setLoading(true);
    stopUploadTimers();
    setUpload(null);
    markAtBottom(true);
    applyUnread(new Set());
    autoTitleRef.current = false;
    titleDirtyRef.current = false;
    titleRef.current = '';
    setTitle('');
    try {
      setInput(localStorage.getItem(`hr_chat_draft_${sessionId}`) || '');
    } catch {
      setInput('');
    }

    (async () => {
      try {
        const data = await apiGet<MessagesResponse>(
          `/api/chat/messages?session_id=${encodeURIComponent(sessionId)}&mark_as_read=true`
        );
        if (cancelled) return;
        const list = data.messages || [];
        setMessages(list);
        applyUnread(unreadOf(list));
        setLoading(false);
        requestAnimationFrame(scrollToBottom);

        const act = await apiGet<ActiveResponse>(
          `/api/chat/stream/active?session_id=${encodeURIComponent(sessionId)}`
        );
        if (cancelled || !act.active?.length) return;
        const latest = [...act.active].sort(
          (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
        )[0];
        if (!latest) return;
        setMessages((prev) =>
          prev.some((m) => m.id === latest.message_id)
            ? prev.map((m) =>
                m.id === latest.message_id
                  ? { ...m, content: latest.content || m.content, streaming: true, is_finished: false }
                  : m
              )
            : [
                ...prev,
                {
                  id: latest.message_id,
                  role: 'assistant',
                  content: latest.content || '',
                  streaming: true,
                  is_finished: false,
                },
              ]
        );
        // last_seq=0 → сервер отдаст весь накопленный буфер в initial_chunk.
        runStream(
          { session_id: sessionId, assistant_message_id: latest.message_id, last_seq: 0 },
          latest.message_id,
          null
        );
      } catch (e) {
        if (!cancelled) {
          setError(errMsg(e));
          setLoading(false);
        }
      }
    })();

    void loadFiles();
    return () => {
      cancelled = true;
    };
  }, [sessionId, runStream, scrollToBottom, loadFiles, markAtBottom, applyUnread, stopUploadTimers]);

  // Обрываем чтение потока при уходе со страницы (генерация продолжается на сервере).
  useEffect(() => () => streamRef.current.handle?.abort(), []);

  // Возврат фокуса на вкладку — синхронизируем историю (не чаще раза в 15 с).
  useEffect(() => {
    const sync = () => {
      if (document.hidden || busyRef.current) return;
      const now = Date.now();
      if (now - lastSyncRef.current < 15000) return;
      lastSyncRef.current = now;
      loadMessages().catch(() => {});
    };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [loadMessages]);

  // ── Отправка ──────────────────────────────────────────────────────────────

  const send = useCallback(
    (text: string, faqId?: number) => {
      const value = text.trim();
      if (!value || busyRef.current || !sessionId) return;
      setError(null);

      const stamp = Date.now();
      const userSlot = `u-${stamp}`;
      const slot = `a-${stamp}`;
      const attached = files.map((f) => ({ id: f.id, name: f.name }));

      setMessages((prev) => [
        ...prev,
        {
          id: userSlot,
          role: 'user',
          content: value,
          is_read: true,
          is_finished: true,
          ts: new Date().toISOString(),
          user_attachments: attached.length ? attached : null,
        },
        { id: slot, role: 'assistant', content: '', is_finished: false, streaming: true, status: 'search' },
      ]);

      setInput('');
      clearDraft();
      setFiles([]); // вложения «потрачены» на это сообщение
      markAtBottom(true);

      const body: Record<string, unknown> = { session_id: sessionId, message: value };
      if (faqId) body.faq_id = faqId;
      runStream(body, slot, userSlot);
    },
    [sessionId, files, clearDraft, runStream, markAtBottom]
  );

  // ── Вопрос, заданный с главной ────────────────────────────────────────────
  // Главная создаёт диалог и уходит сюда с `?q=<вопрос>`. Отправляем его один
  // раз — после загрузки истории, иначе ответ loadMessages затрёт оптимистично
  // добавленные пузыри. Параметр сразу убираем из адреса, чтобы вопрос не
  // ушёл повторно при перезагрузке или возврате «назад».
  // location читаем напрямую, а не через useSearchParams: так же сделано в
  // components/chrome.tsx — иначе страницу пришлось бы оборачивать в Suspense.
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current || loading || !sessionId) return;
    let q = '';
    try {
      q = new URLSearchParams(window.location.search).get('q') || '';
    } catch {
      /* нестандартный URL */
    }
    if (!q.trim()) return;
    askedRef.current = true;
    router.replace(`/chat/${sessionId}`);
    send(q);
  }, [loading, sessionId, router, send]);

  // ── Выделение сообщений и пересылка в мессенджер (порт #chatSelTools) ──────

  const exitSelect = useCallback(() => {
    setSelMode(false);
    setSelected(new Set());
  }, []);

  const toggleSelect = useCallback((id: ChatMsg['id']) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startSelect = useCallback((m: ChatMsg) => {
    setSelMode(true);
    setSelected((prev) => new Set(prev).add(m.id));
  }, []);

  useEffect(() => {
    if (!selMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitSelect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selMode, exitSelect]);

  const selectedMsgs = messages.filter((m) => selected.has(m.id));

  const copySelected = () => {
    const text = groupedChatText(selectedMsgs);
    exitSelect();
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => {});
    toast({ title: 'Скопировано', body: `Сообщений: ${selectedMsgs.length}` });
  };

  // Несколько сообщений уходят одним текстом (как в легаси chat.js),
  // одиночный ответ ассистента — снимком через forward_message_id.
  const forwardSelected = () => {
    const text = groupedChatText(selectedMsgs);
    if (!text) return;
    setFwdError('');
    setForward({ text, count: selectedMsgs.length });
  };

  const forwardOne = (m: ChatMsg) => {
    setFwdError('');
    if (m.role === 'assistant' && typeof m.id === 'number') {
      setForward({ snapshotId: m.id, count: 1 });
      return;
    }
    const text = (m.content || '').trim();
    if (!text) return;
    setForward({ text, count: 1 });
  };

  const doForward = async (target: ForwardTarget) => {
    if (!forward) return;
    setFwdBusy(true);
    setFwdError('');
    const body: Record<string, unknown> = target.general
      ? { general: true }
      : { peer_id: target.peerId };
    if (forward.snapshotId != null) {
      body.forward_message_id = forward.snapshotId;
      body.content = '';
    } else {
      body.content = forward.text;
    }
    try {
      await apiPost('/api/messenger/send', body);
      setForward(null);
      exitSelect();
      toast({ title: 'Переслано', body: target.name });
    } catch (e) {
      setFwdError(errMsg(e));
    } finally {
      setFwdBusy(false);
    }
  };

  // ── Действия над сообщениями (колбэки MessageBubble) ──────────────────────

  const onFeedback = useCallback(
    async (id: number, rating: number) => {
      patchMsg(id, { user_rating: rating });
      try {
        await apiPost('/api/chat/feedback', { message_id: id, rating });
      } catch (e) {
        setError(errMsg(e));
      }
    },
    [patchMsg]
  );

  const onVariant = useCallback(
    async (id: number, dir: number) => {
      try {
        await apiPost('/api/chat/variant', { session_id: sessionId, message_id: id, direction: dir });
        await loadMessages(); // видимая ветка меняется целиком
      } catch (e) {
        setError(errMsg(e));
      }
    },
    [sessionId, loadMessages]
  );

  const onEdit = useCallback(
    async (id: number, text: string) => {
      if (busyRef.current) return;
      try {
        const data = await apiPost<{ success: boolean; assistant_message_id: number }>(
          '/api/chat/edit',
          { session_id: sessionId, message_id: id, text }
        );
        await loadMessages(); // новая ветка вопроса + заготовка ответа
        if (!data.assistant_message_id) return;
        patchMsg(data.assistant_message_id, { streaming: true, status: 'search' });
        markAtBottom(true);
        runStream(
          { session_id: sessionId, assistant_message_id: data.assistant_message_id, last_seq: 0 },
          data.assistant_message_id,
          null
        );
      } catch (e) {
        setError(errMsg(e));
      }
    },
    [sessionId, loadMessages, patchMsg, runStream, markAtBottom]
  );

  const onRetry = useCallback(
    (id: number) => {
      if (busyRef.current || !sessionId) return;
      // Всё ниже перегенерируемого ответа принадлежит старой ветке — прячем сразу.
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === id);
        if (i < 0) return prev;
        return [
          ...prev.slice(0, i),
          {
            ...prev[i],
            content: '',
            sources: null,
            meta: null,
            attachment: null,
            fact_check: null,
            is_finished: false,
            streaming: true,
            status: 'search',
          },
        ];
      });
      markAtBottom(true);
      runStream({ session_id: sessionId, retry_of: id, use_rag: true }, id, null);
    },
    [sessionId, runStream, markAtBottom]
  );

  // ── Новый диалог из сайдбара ──────────────────────────────────────────────

  const newDialogue = async () => {
    try {
      const data = await apiPost<{ success: boolean; session_id: string }>('/api/dialogues', {});
      if (data.session_id) router.push(`/chat/${data.session_id}`);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  // ── Drag-and-drop файлов на панель чата ───────────────────────────────────

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');

  const current = dialogues.find((d) => d.session_id === sessionId);
  const unreadCount = unreadIds.size;

  // Плавающий индикатор (порт updateFloatingIndicator): во время генерации внизу —
  // скрыт, отскроллили вверх — «Вернуться к ответу»; иначе счётчик непрочитанных
  // либо обычная кнопка «вниз».
  const fab: 'none' | 'return' | 'unread' | 'down' = busy
    ? atBottom
      ? 'none'
      : 'return'
    : unreadCount > 0
      ? 'unread'
      : atBottom
        ? 'none'
        : 'down';

  return (
    <div className="relative flex-1 max-w-6xl w-full mx-auto px-4 py-6 flex flex-col md:flex-row gap-4 md:gap-6 h-[calc(100vh-100px)]">
      {/* ЛЕВАЯ ПАНЕЛЬ — список диалогов */}
      <aside
        className={`${
          sidebarOpen ? 'flex' : 'hidden'
        } md:flex w-full bg-white border border-gray-100 rounded-2xl p-4 shadow-sm flex-col gap-3 shrink-0 max-h-64 md:max-h-none overflow-hidden transition-[width,opacity,padding] duration-200 ${
          collapsed
            ? 'md:w-0 md:min-w-0 md:p-0 md:opacity-0 md:border-transparent md:pointer-events-none'
            : 'md:w-72 md:opacity-100'
        }`}
      >
        <Link
          href="/dialogues"
          className="flex items-center gap-2 text-xs font-semibold text-[#0f1c3f] hover:text-[#2563eb] transition pb-2 border-b border-gray-100"
        >
          <ChevronLeft size={14} />
          <span>Все диалоги</span>
        </Link>

        <button
          type="button"
          onClick={newDialogue}
          className="w-full bg-[#2563eb] text-white px-4 py-2.5 rounded-xl font-semibold text-xs flex items-center justify-center gap-2 hover:bg-[#1e40af] transition shadow-md shadow-blue-100"
        >
          <Plus size={14} /> Новый диалог
        </button>

        <input
          type="text"
          value={sbQuery}
          onChange={(e) => {
            setSbQuery(e.target.value);
            setSbLimit(SB_PAGE);
          }}
          placeholder="Поиск по диалогам…"
          aria-label="Поиск по диалогам"
          className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs text-slate-600 focus:outline-none focus:border-[#2563eb] focus:bg-white transition"
        />

        <div className="flex items-center gap-1 text-[11px] font-semibold">
          {SB_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setSbFilter(f.key);
                setSbLimit(SB_PAGE);
              }}
              className={`flex-1 px-2 py-1.5 rounded-lg transition ${
                sbFilter === f.key
                  ? 'bg-[#2563eb] text-white'
                  : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-1 -mx-1 px-1">
          {dialogues.length === 0 ? (
            <p className="text-[11px] text-gray-400 text-center py-6">
              {sbQuery.trim() ? 'Ничего не найдено' : 'Диалогов пока нет'}
            </p>
          ) : (
            dialogues.map((d) => {
              const active = d.session_id === sessionId;
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={!d.session_id}
                  onClick={() => {
                    setSidebarOpen(false);
                    if (d.session_id) router.push(`/chat/${d.session_id}`);
                  }}
                  className={`w-full text-left px-3 py-2.5 rounded-xl transition flex flex-col gap-0.5 border ${
                    active
                      ? 'bg-blue-50 border-blue-100'
                      : 'border-transparent hover:bg-gray-50 disabled:opacity-50'
                  }`}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {d.unread && <span className="w-1.5 h-1.5 rounded-full bg-[#2563eb] shrink-0" />}
                    <span
                      className={`text-xs font-bold truncate ${
                        active ? 'text-[#2563eb]' : 'text-[#0f1c3f]'
                      }`}
                    >
                      {d.title}
                    </span>
                    {d.is_finished && (
                      <span className="ml-auto text-[9px] font-bold text-emerald-600 shrink-0">
                        РЕШЁН
                      </span>
                    )}
                  </span>
                  {d.last_message && (
                    <span className="text-[11px] text-gray-400 truncate">{d.last_message.text}</span>
                  )}
                </button>
              );
            })
          )}

          {sbTotal > dialogues.length && sbLimit < SB_MAX && (
            <button
              type="button"
              onClick={() => setSbLimit((v) => Math.min(SB_MAX, v + SB_PAGE))}
              className="mt-1 w-full py-2 rounded-xl text-[11px] font-semibold text-[#2563eb] hover:bg-blue-50 transition"
            >
              Показать ещё {Math.min(SB_PAGE, sbTotal - dialogues.length)}
            </button>
          )}
        </div>
      </aside>

      {/* Язычок сворачивания панели (порт .chat-sidebar-toggle, chat.js:2394-2401).
          Единообразно с мессенджером: едет вместе с краем панели. */}
      <button
        type="button"
        onClick={toggleCollapsed}
        title={collapsed ? 'Показать список диалогов' : 'Свернуть список диалогов'}
        aria-label="Список диалогов"
        aria-pressed={collapsed}
        style={{ left: collapsed ? '0.25rem' : 'calc(19rem - 0.875rem)' }}
        className="hidden md:flex absolute top-1/2 -translate-y-1/2 z-20 w-7 h-14 items-center justify-center rounded-lg bg-white border border-gray-100 shadow-sm text-gray-400 hover:text-[#2563eb] transition-[left,color] duration-200"
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>

      {/* ПРАВАЯ ПАНЕЛЬ — чат */}
      <section
        className="flex-1 min-w-0 bg-white border border-gray-100 rounded-2xl shadow-sm flex flex-col overflow-hidden relative"
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(e) => {
          if (hasFiles(e)) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
        }}
      >
        {dragOver && (
          <div className="absolute inset-0 z-20 bg-blue-50/80 border-2 border-dashed border-[#2563eb] rounded-2xl flex items-center justify-center text-sm font-semibold text-[#2563eb] pointer-events-none px-6 text-center">
            Отпустите файл — он прикрепится к следующему сообщению
          </div>
        )}

        {/* Шапка: название диалога (инлайн-редактирование) */}
        <div className="p-4 border-b border-gray-50 flex items-center gap-3 bg-gray-50/30">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="md:hidden p-2 rounded-lg text-slate-500 hover:bg-gray-100 transition shrink-0"
            title="Список диалогов"
          >
            <Menu size={16} />
          </button>
          <div className="flex-1 min-w-0">
            <input
              type="text"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder={DEFAULT_TITLE}
              disabled={!dialogueId}
              aria-label="Название диалога"
              className="w-full bg-transparent font-bold text-sm text-[#0f1c3f] placeholder-gray-300 focus:outline-none border-b border-transparent focus:border-[#2563eb] transition py-0.5"
            />
            {/* Статус + бейдж непрочитанных (порт updateUnreadIndicator) */}
            <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
              {loading ? (
                'Загрузка диалога…'
              ) : (
                <>
                  <span>{busy ? 'Генерация…' : 'Онлайн'}</span>
                  {unreadCount > 0 && (
                    <>
                      <span aria-hidden="true">•</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-[#2563eb] font-semibold tabular-nums">
                        {unreadCount} непрочитанных
                      </span>
                    </>
                  )}
                  {titleStatus && <span className="text-gray-300">· {titleStatus}</span>}
                </>
              )}
            </p>
          </div>
          {current?.is_finished && (
            <span className="text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider bg-emerald-50 text-emerald-600 shrink-0">
              Решён
            </span>
          )}
        </div>

        {/* Панель действий над выделенными сообщениями (порт #chatSelTools) */}
        {selMode && selected.size > 0 && (
          <div className="h-12 px-3 flex items-center gap-2 bg-gradient-to-r from-[#1e40af]/95 to-[#2563eb]/95 text-white shadow-md shrink-0">
            <span className="text-xs font-semibold">
              <b>{selected.size}</b> выбрано
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={copySelected}
                title="Копировать"
                className="p-2 rounded-lg hover:bg-white/15 transition"
              >
                <Copy size={16} />
              </button>
              <button
                type="button"
                onClick={forwardSelected}
                title="Переслать коллеге"
                className="p-2 rounded-lg hover:bg-white/15 transition"
              >
                <Forward size={16} />
              </button>
              <button
                type="button"
                onClick={exitSelect}
                title="Отмена"
                className="p-2 rounded-lg hover:bg-white/15 transition"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Лента сообщений */}
        <div className="flex-1 min-h-0 relative">
          <div
            ref={feedRef}
            onScroll={() => {
              const el = feedRef.current;
              if (el) markAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
              scheduleVisible();
            }}
            onClick={onSourcesClick}
            className={`h-full overflow-y-auto p-4 md:p-6 space-y-4 bg-[#fcfdfe] ${
              selMode ? 'select-none' : ''
            }`}
          >
            {error && <ErrorCallout>{error}</ErrorCallout>}

            {loading ? (
              <p className="text-center text-gray-400 text-sm py-10">Загрузка сообщений…</p>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center text-center gap-2 py-12">
                <h2 className="text-xl md:text-2xl font-black text-[#0f1c3f] tracking-tight">
                  Спроси. <span className="text-gradient">Остальное за HR-помощником.</span>
                </h2>
                <p className="text-xs text-gray-400 max-w-sm font-medium leading-relaxed">
                  Задайте вопрос своими словами или выберите готовый из списка частых вопросов под
                  полем ввода.
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  busy={busy}
                  selection={{ mode: selMode, checked: selected.has(m.id) }}
                  onFeedback={onFeedback}
                  onVariant={onVariant}
                  onEdit={onEdit}
                  onRetry={onRetry}
                  onForward={forwardOne}
                  onStartSelect={startSelect}
                  onToggleSelect={toggleSelect}
                  onClarify={(text) => send(text)}
                />
              ))
            )}
          </div>
        </div>

        {/* Композер (перекрывает низ ленты — отступ держит useComposerPadding) */}
        <div
          ref={composerRef}
          className="absolute inset-x-0 bottom-0 z-10 p-3 md:p-4 bg-white border-t border-gray-50 flex flex-col gap-2"
        >
          {/* Плавающий индикатор непрочитанных / возврата к ответу — над композером */}
          {fab !== 'none' && (
            <button
              type="button"
              onClick={fab === 'unread' ? scrollToFirstUnread : goBottom}
              title={
                fab === 'unread'
                  ? 'Перейти к первому непрочитанному'
                  : fab === 'return'
                    ? 'Вернуться к ответу'
                    : 'Вниз'
              }
              aria-label={
                fab === 'unread'
                  ? 'Перейти к первому непрочитанному'
                  : fab === 'return'
                    ? 'Вернуться к ответу'
                    : 'Прокрутить вниз'
              }
              className={`absolute right-4 -top-12 z-10 flex items-center rounded-full bg-white border border-gray-200 shadow-md transition animate-fade-in ${
                fab === 'down'
                  ? 'w-9 h-9 justify-center text-slate-500 hover:text-[#2563eb]'
                  : 'gap-1.5 px-3 h-9 text-xs font-semibold text-[#0f1c3f] hover:border-[#2563eb] hover:text-[#2563eb]'
              }`}
            >
              {fab === 'unread' && (
                <>
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-[#2563eb] text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
                    {unreadCount}
                  </span>
                  <span>непрочитанных</span>
                </>
              )}
              {fab === 'return' && <span>Вернуться к ответу</span>}
              <ArrowDown size={fab === 'down' ? 16 : 14} />
            </button>
          )}

          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {files.map((f) => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1.5 bg-blue-50/60 border border-blue-100 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-600 animate-fade-in"
                >
                  <FileText size={12} className="text-[#2563eb] shrink-0" />
                  <span className="truncate max-w-[12rem]">{f.name}</span>
                  <span className="text-gray-400">{formatBytes(f.size)}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(f.id)}
                    className="text-gray-400 hover:text-red-500 transition"
                    title="Открепить"
                    aria-label="Открепить файл"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <FaqPicker disabled={busy} onPick={(text, faqId) => send(text, faqId)} />

          <div className="flex gap-2 bg-gray-50 p-1.5 rounded-xl border border-gray-200 focus-within:border-[#2563eb] focus-within:bg-white transition-all items-end">
            <input
              type="file"
              ref={fileRef}
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void uploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="p-2.5 text-gray-400 hover:text-[#2563eb] transition disabled:opacity-50 shrink-0"
              title="Прикрепить файл к следующему сообщению"
            >
              {uploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
            </button>

            <textarea
              ref={taRef}
              rows={1}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              onPaste={(e) => {
                const pasted = e.clipboardData?.files;
                if (pasted && pasted.length) {
                  e.preventDefault();
                  void uploadFiles(pasted);
                }
              }}
              placeholder="Вы можете задать свой вопрос здесь"
              className="flex-1 bg-transparent px-2 py-2.5 text-sm text-slate-700 focus:outline-none placeholder-gray-300 resize-none max-h-40"
            />

            <button
              type="button"
              onClick={() => (busy ? void stopStream() : send(input))}
              disabled={!busy && !input.trim()}
              className={`p-2.5 rounded-lg transition shadow-md shrink-0 text-white ${
                busy
                  ? 'bg-red-500 hover:bg-red-600'
                  : 'bg-[#2563eb] hover:bg-[#1e40af] disabled:opacity-50'
              }`}
              title={busy ? 'Прервать генерацию' : 'Отправить'}
              aria-label={busy ? 'Прервать генерацию' : 'Отправить'}
            >
              {busy ? <Square size={16} /> : <Send size={16} />}
            </button>
          </div>

          {/* Строка статуса загрузки файла (порт .upload-status из chat.html) */}
          {upload && (
            <div className="flex flex-col gap-1.5 animate-fade-in" aria-live="polite">
              <span
                className={`text-[11px] font-semibold ${
                  upload.tone === 'error'
                    ? 'text-red-600'
                    : upload.tone === 'success'
                      ? 'text-emerald-600'
                      : 'text-slate-500'
                }`}
              >
                {upload.text}
              </span>
              <div
                className="h-1 rounded-full bg-gray-100 overflow-hidden"
                role="progressbar"
                aria-valuenow={upload.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`h-full rounded-full transition-all duration-300 ease-out ${
                    upload.tone === 'error'
                      ? 'bg-red-500'
                      : upload.tone === 'success'
                        ? 'bg-emerald-500'
                        : 'bg-[#2563eb]'
                  }`}
                  style={{ width: `${upload.percent}%` }}
                />
              </div>
            </div>
          )}

          <p className="text-[10px] text-gray-300 font-medium">
            Enter — отправить, Shift+Enter — перенос строки. Файлы можно перетащить в окно чата или
            вставить из буфера.
          </p>
        </div>
      </section>

      {sourcesModal}

      {forward && (
        <ForwardModal
          count={forward.count}
          busy={fwdBusy}
          error={fwdError}
          onPick={doForward}
          onClose={() => {
            setForward(null);
            setFwdError('');
          }}
        />
      )}
    </div>
  );
}
