import 'server-only';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { baseName, DOCS_DIR, fromDocsPath, resolveInsideDocs, suffixOf, validationError } from './news';

// Общие помощники домена «База знаний» — порт вспомогательной логики
// backend/routes/kb.py (_review_status, отдача файлов через FileResponse,
// разбор Body(...) и Query-параметров FastAPI).
// Вынесено сюда, потому что этим пользуются 15 route-handler'ов; путевые
// утилиты (DOCS_DIR/resolveInsideDocs) переиспользуем из lib/news.ts — они
// не про новости, просто исторически живут там.

export { baseName, DOCS_DIR, fromDocsPath, resolveInsideDocs, suffixOf };

/** settings.docs_templates — рядом с docs/local и docs/news. */
export const TEMPLATES_DIR = path.join(DOCS_DIR, 'templates');

// ── ошибки ─────────────────────────────────────────────────────────────────

/**
 * Место, где Python падает необработанным ValueError/TypeError (например
 * `int("abc")`). Статус тот же (500), но тело у FastAPI — plain text
 * "Internal Server Error", а у нас JSON: точнее воспроизвести нечем.
 */
export function internalError(): NextResponse {
  return NextResponse.json({ detail: 'Internal Server Error' }, { status: 500 });
}

/** 422 на некорректное тело — как Body(...) в FastAPI. */
function invalidBody(type: string, loc: unknown[], msg: string, input: unknown): NextResponse {
  return NextResponse.json({ detail: [{ type, loc, msg, input }] }, { status: 422 });
}

/**
 * Разбор `body: dict = Body(...)`: тело обязательно и должно быть объектом.
 * Формы ошибок повторяют pydantic (см. app/api/admin/users/[uid]/route.ts).
 */
export async function jsonBody(
  request: NextRequest
): Promise<{ body: Record<string, unknown> } | { response: NextResponse }> {
  const raw = await request.text();
  if (!raw) return { response: invalidBody('missing', ['body'], 'Field required', null) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { response: invalidBody('json_invalid', ['body', 0], 'JSON decode error', {}) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      response: invalidBody('dict_type', ['body'], 'Input should be a valid dictionary', parsed),
    };
  }
  return { body: parsed as Record<string, unknown> };
}

// ── path-параметры ─────────────────────────────────────────────────────────

/**
 * Числовой path-параметр FastAPI. `value: null` — число корректное, но не
 * влезает в int4 PostgreSQL: такой записи заведомо нет, вызывающий отдаёт 404
 * (Python на этом месте уронил бы запрос в 500 из-за DataError).
 */
export function parsePathId(
  raw: string,
  name: string
): { value: number | null } | { response: NextResponse } {
  if (!/^[+-]?\d+$/.test(raw)) {
    return {
      response: validationError(
        ['path', name],
        'int_parsing',
        'Input should be a valid integer, unable to parse string as an integer',
        raw
      ),
    };
  }
  const n = Number.parseInt(raw, 10);
  return { value: n >= -2147483648 && n <= 2147483647 ? n : null };
}

// ── приведение типов «как в Python» ────────────────────────────────────────

/** Python bool(): пустые строка/список/словарь тоже дают False. */
export function pyBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python str(): None/True/False печатаются словами, остальное — как есть. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value) ?? '';
  return String(value);
}

/** Python int(): null — там, где Python бросил бы ValueError/TypeError. */
export function pyInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string') {
    return /^\s*[+-]?\d+\s*$/.test(value) ? Number.parseInt(value.trim(), 10) : null;
  }
  return null;
}

// ── даты ───────────────────────────────────────────────────────────────────

/** `date.isoformat()` для колонок @db.Date (в них лежит полночь UTC). */
export function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * `datetime.strptime(s, "%Y-%m-%d").date()`. Как и Python, допускает
 * год/месяц/день без ведущих нулей, но отвергает несуществующие даты.
 */
export function parsePyDate(s: string): Date | null {
  const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 100) dt.setUTCFullYear(y); // Date.UTC трактует 0..99 как 19xx
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}

/** Календарный день в мс — общий знаменатель для сравнения date и datetime. */
function dayMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface ReviewInput {
  is_archived: boolean;
  effective_from: Date | null;
  effective_to: Date | null;
  indexed_at: Date | null;
  created_at: Date | null;
}

/**
 * Порт _review_status: 'expired' — вышел срок действия, 'review_due' — не
 * пересматривался больше года, null — свежий или архивный.
 */
export function reviewStatus(d: ReviewInput): string | null {
  if (d.is_archived) return null;
  const now = new Date();
  // date.today() — локальная дата сервера, не UTC.
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  if (d.effective_to && dayMs(d.effective_to) < today) return 'expired';

  let ref: number | null = d.effective_from ? dayMs(d.effective_from) : null;
  if (ref === null && d.indexed_at) ref = dayMs(d.indexed_at);
  if (ref === null && d.created_at) ref = dayMs(d.created_at);
  return ref !== null && today - ref > YEAR_MS ? 'review_due' : null;
}

// ── JSON-колонки ───────────────────────────────────────────────────────────

/** JSON-поле как список (Python: `x or []`). */
export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** JSON-поле как словарь (Python: `x or {}`). */
export function asDict(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ── отдача файлов ──────────────────────────────────────────────────────────

// Значения bool так разбирает pydantic; всё остальное — ошибка валидации.
const TRUE_VALUES = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_VALUES = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

/** `inline: bool = Query(default=False)` со «строгим» разбором FastAPI. */
export function boolQuery(
  raw: string | null,
  name: string
): { value: boolean } | { response: NextResponse } {
  if (raw === null) return { value: false };
  const v = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return { value: true };
  if (FALSE_VALUES.has(v)) return { value: false };
  return {
    response: validationError(
      ['query', name],
      'bool_parsing',
      'Input should be a valid boolean, unable to interpret input',
      raw
    ),
  };
}

/**
 * `x: int | None = None` в сигнатуре роута — необязательный числовой параметр.
 * Копия intQuery из lib/messenger.ts: тянуть сюда весь домен мессенджера
 * (а с ним SSE и web-push) ради одной функции разбора — дороже дубля.
 */
export function intQuery(
  raw: string | null,
  name: string
): { value: number | null } | { response: NextResponse } {
  if (raw === null) return { value: null };
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    return {
      response: validationError(
        ['query', name],
        'int_parsing',
        'Input should be a valid integer, unable to parse string as an integer',
        raw
      ),
    };
  }
  return { value: Number.parseInt(raw.trim(), 10) };
}

// Конвертация в PDF для ?as=pdf живёт в lib/file-preview.ts (LibreOffice + кэш).
// Здесь её нет намеренно: file-preview импортирует отсюда fileResponse, обратная
// зависимость дала бы цикл модулей.

/** urllib.parse.quote(s) с safe='/' — нужен для Content-Disposition, как в Starlette. */
function pyQuote(s: string): string {
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~/-]/.test(ch)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const quoted = pyQuote(filename);
  return quoted === filename
    ? `${type}; filename="${filename}"`
    : `${type}; filename*=utf-8''${quoted}`;
}

/** Path.exists() и Path.is_file() одним вызовом. */
export async function isFile(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  return Boolean(info?.isFile());
}

// ── шаблоны документов ─────────────────────────────────────────────────────

/**
 * Порт template_display_path из backend/services/documents/generator.py:
 * версия шаблона ДЛЯ ПРОСМОТРА/СКАЧИВАНИЯ. Для бланка .docx без {{переменных}}
 * отдаётся копия с подставленными НАЗВАНИЯМИ авто-полей (кэш
 * docs/templates/.previews), для jinja-шаблонов и pdf — оригинал.
 *
 * Сам рендер живёт в lib/docs/generator.ts. Импорт динамический: lib/docs/*
 * берёт отсюда мелкие утилиты (pyStr), и статическая ссылка замкнула бы цикл
 * модулей; к моменту вызова оба модуля уже инициализированы.
 */
export async function templateDisplayPath(tplId: number, src: string): Promise<string> {
  const { templatePreviewPath } = await import('./docs/generator');
  return templatePreviewPath(tplId, src);
}

/** Аналог starlette FileResponse: потоковая отдача с теми же заголовками. */
export async function fileResponse(
  file: string,
  opts: { filename: string; mediaType: string; inline: boolean }
): Promise<NextResponse | null> {
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) return null;

  const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
  return new NextResponse(stream, {
    headers: {
      'Content-Type': opts.mediaType,
      'Content-Length': String(info.size),
      'Content-Disposition': contentDisposition(opts.inline ? 'inline' : 'attachment', opts.filename),
    },
  });
}
