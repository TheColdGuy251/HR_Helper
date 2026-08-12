'use client';

// Тонкая обвязка над fetch для работы с FastAPI-бэкендом.
// Всё ходит на тот же origin (Next проксирует /api и /static на uvicorn:8000),
// cookie `hr_session` прикладывается браузером автоматически.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function redirectToLogin() {
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    const next = window.location.pathname;
    window.location.href = next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login';
  }
}

/** Достаёт человекочитаемое сообщение из разных форматов ошибок бэкенда. */
async function extractError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === 'string') return data.detail;
    if (typeof data?.error === 'string') return data.error;
    if (typeof data?.message === 'string') return data.message;
  } catch {
    /* тело не JSON */
  }
  return `Ошибка сервера (${res.status})`;
}

async function handle<T>(res: Response, opts?: { skipAuthRedirect?: boolean }): Promise<T> {
  if (res.status === 401 && !opts?.skipAuthRedirect) {
    redirectToLogin();
    throw new ApiError(401, 'Требуется авторизация');
  }
  if (!res.ok) {
    throw new ApiError(res.status, await extractError(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function apiGet<T = unknown>(url: string, opts?: { skipAuthRedirect?: boolean }): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  return handle<T>(res, opts);
}

export async function apiJson<T = unknown>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  opts?: { skipAuthRedirect?: boolean }
): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handle<T>(res, opts);
}

export const apiPost = <T = unknown>(url: string, body?: unknown, opts?: { skipAuthRedirect?: boolean }) =>
  apiJson<T>('POST', url, body, opts);
export const apiPatch = <T = unknown>(url: string, body?: unknown) => apiJson<T>('PATCH', url, body);
export const apiDelete = <T = unknown>(url: string) => apiJson<T>('DELETE', url);

/** multipart/form-data загрузка (файлы + поля). */
export async function apiUpload<T = unknown>(url: string, formData: FormData): Promise<T> {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: formData });
  return handle<T>(res);
}

// ---------------------------------------------------------------------------
// Чтение SSE-потока из POST-запроса (чат-стриминг /api/chat/stream).
// Браузерный EventSource умеет только GET, поэтому читаем body руками.
// ---------------------------------------------------------------------------

export interface SSEStreamHandle {
  abort: () => void;
  done: Promise<void>;
}

export function postSSE(
  url: string,
  body: unknown,
  onFrame: (data: Record<string, unknown>) => void,
  onError?: (err: Error) => void
): SSEStreamHandle {
  const controller = new AbortController();

  const done = (async () => {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, 'Требуется авторизация');
    }
    if (!res.ok || !res.body) {
      throw new ApiError(res.status, await extractError(res));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });

      // Кадры разделяются пустой строкой; каждый кадр — строки `data: {...}`.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split('\n')) {
          const m = line.match(/^data:\s?(.*)$/);
          if (!m) continue;
          try {
            const payload = JSON.parse(m[1]);
            if (payload && typeof payload === 'object' && !payload.noop) {
              onFrame(payload);
            }
          } catch {
            /* пропускаем некорректный кадр */
          }
        }
      }
    }
  })().catch((err: Error) => {
    if (err?.name !== 'AbortError') onError?.(err);
  });

  return { abort: () => controller.abort(), done };
}

// ---------------------------------------------------------------------------
// Утилиты форматирования (порт time_ago из utils/templating.py)
// ---------------------------------------------------------------------------

export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'только что';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} дн назад`;
  return d.toLocaleDateString('ru-RU');
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}
