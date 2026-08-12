'use client';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { toast } from '@/components/events';

// Тост «Ответ готов», если пользователь ушёл со страницы чата, а генерация
// дописалась. Порт scripts.js (pendingGenerations + HRToast).
//
// Хранилище — localStorage.pendingGenerations: массив
//   { sessionId, dialogueId, title, ts }
// Проверка — GET /api/chat/stream/active?session_id= (пустой active = готово).

const KEY = 'pendingGenerations';
const DEFAULT_TITLE = 'Новый диалог';

const STALE_MS = 10 * 60 * 1000; // старше 10 минут — забываем
const GRACE_MS = 4000;           // даём стриму стартовать
const RECHECK_MS = 2500;         // пока список непуст
const DEBOUNCE_MS = 250;
const FALLBACK_MS = 60000;       // фолбэк, если SSE недоступен

export interface PendingGen {
  sessionId: string;
  dialogueId: string;
  title: string;
  ts: number;
}

export function readPendingGens(): PendingGen[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? (list as PendingGen[]) : [];
  } catch {
    return [];
  }
}

function writePendingGens(list: PendingGen[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* приватный режим */
  }
}

/** Отметить, что в сессии идёт генерация (вызывается со страницы чата). */
export function recordPendingGen(sessionId: string, dialogueId: number | null, title: string) {
  if (!sessionId) return;
  const list = readPendingGens().filter((p) => p.sessionId !== sessionId);
  list.push({
    sessionId,
    dialogueId: String(dialogueId || ''),
    title: title.trim() || 'Диалог',
    ts: Date.now(),
  });
  writePendingGens(list);
}

/** Генерация завершилась при открытой странице — тост не нужен. */
export function clearPendingGen(sessionId: string) {
  if (!sessionId) return;
  writePendingGens(readPendingGens().filter((p) => p.sessionId !== sessionId));
}

interface ActiveResponse {
  success?: boolean;
  active?: unknown[];
}

interface DialoguesResponse {
  items?: { title?: string; session_id?: string | null }[];
}

/** Название диалога по session_id — для текста тоста. */
async function fetchDialogueTitle(sessionId: string): Promise<string> {
  try {
    const d = await apiGet<DialoguesResponse>('/api/dialogues?filter=all&page=1&page_size=50');
    const item = (d.items || []).find((x) => x.session_id === sessionId);
    return item?.title || '';
  } catch {
    return '';
  }
}

export function PendingGenerations() {
  const pathname = usePathname();
  const pathRef = useRef(pathname);

  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let alive = true;

    async function check() {
      if (running || !alive) return;
      const list = readPendingGens();
      if (!list.length) return;
      running = true;

      const remaining: PendingGen[] = [];
      try {
        for (const p of list) {
          if (!p?.sessionId) continue;
          // Пользователь на самой странице чата — тост не нужен, но запись храним.
          if (pathRef.current === `/chat/${p.sessionId}`) {
            remaining.push(p);
            continue;
          }
          const age = Date.now() - (p.ts || 0);
          if (age > STALE_MS) continue;
          if (age < GRACE_MS) {
            remaining.push(p);
            continue;
          }
          try {
            const d = await apiGet<ActiveResponse>(
              `/api/chat/stream/active?session_id=${encodeURIComponent(p.sessionId)}`,
              { skipAuthRedirect: true }
            );
            if (!(d.success && (!d.active || d.active.length === 0))) {
              remaining.push(p); // ещё генерируется
              continue;
            }
            const fresh = await fetchDialogueTitle(p.sessionId);
            const name = fresh && fresh !== DEFAULT_TITLE ? fresh : p.title;
            toast({
              title: 'HR-ассистент',
              body: name && name !== DEFAULT_TITLE ? `Ответ готов · ${name}` : 'Ответ готов',
              url: `/chat/${encodeURIComponent(p.sessionId)}`,
            });
          } catch {
            remaining.push(p); // сеть моргнула — проверим позже
          }
        }
      } finally {
        running = false;
      }

      writePendingGens(remaining);
      if (remaining.length && alive) schedule(RECHECK_MS);
    }

    function schedule(delay = DEBOUNCE_MS) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void check(), delay);
    }

    // Основной триггер — SSE (generation_done / dialogue_title → hr:dialogues-changed).
    const onEvent = () => schedule(200);
    window.addEventListener('hr:dialogues-changed', onEvent);

    if (readPendingGens().length) void check();
    // Фолбэк, если SSE недоступен.
    const fallback = setInterval(() => {
      if (readPendingGens().length) void check();
    }, FALLBACK_MS);

    return () => {
      alive = false;
      window.removeEventListener('hr:dialogues-changed', onEvent);
      clearInterval(fallback);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return null;
}
