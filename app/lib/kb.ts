import 'server-only';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { asUuid } from './ids';
import {
  baseName,
  DOCS_DIR,
  parseIdParam,
  resolveInsideDocs,
  suffixOf,
  uuidError,
  validationError,
} from './news';

// Общие помощники домена "База знаний": статус актуальности, отдача файлов,
// разбор тела запроса и query-параметров. Ими пользуются 15 route-handler'ов;
// путевые утилиты (DOCS_DIR/resolveInsideDocs) берём из lib/news.ts - они не
// про новости, просто исторически живут там.

export { baseName, DOCS_DIR, resolveInsideDocs, suffixOf, uuidError };

/** Идентификатор записи в пути (UUID); некорректный - 422. */
export const parsePathId = parseIdParam;

/** Каталог шаблонов - рядом с docs/local и docs/news. */
export const TEMPLATES_DIR = path.join(DOCS_DIR, 'templates');

// ошибки

/** 500 на данные, которые не удалось разобрать (например нечисловая строка вместо числа). */
export function internalError(): NextResponse {
  return NextResponse.json({ detail: 'Internal Server Error' }, { status: 500 });
}

/** 422 на некорректное тело запроса. */
function invalidBody(type: string, loc: unknown[], msg: string, input: unknown): NextResponse {
  return NextResponse.json({ detail: [{ type, loc, msg, input }] }, { status: 422 });
}

/**
 * Тело запроса обязательно и должно быть JSON-объектом. Формы ошибок - как в
 * app/api/admin/users/[uid]/route.ts.
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

// path-параметры

/** Необязательный идентификатор в query-строке: null, если параметра нет. */
export function uuidQuery(
  raw: string | null,
  name: string
): { value: string | null } | { response: NextResponse } {
  if (raw === null) return { value: null };
  const id = asUuid(raw);
  return id ? { value: id } : { response: uuidError(['query', name], raw) };
}

// приведение типов ""

/** Истинность значения: пустые строка, массив и объект тоже дают false. */
export function pyBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Строка из значения: null/true/false дают "None"/"True"/"False", остальное - как есть. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value) ?? '';
  return String(value);
}

/** Целое из значения; null, если преобразовать нельзя. */
export function pyInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string') {
    return /^\s*[+-]?\d+\s*$/.test(value) ? Number.parseInt(value.trim(), 10) : null;
  }
  return null;
}

// даты

/** `date.isoformat()` для колонок @db.Date (в них лежит полночь UTC). */
export function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Дата ГГГГ-ММ-ДД: год/месяц/день допускаются без ведущих нулей,
 * несуществующие даты отвергаются.
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

/** Календарный день в мс - общий знаменатель для сравнения date и datetime. */
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
 * 'expired' - вышел срок действия, 'review_due' - не
 * пересматривался больше года, null - свежий или архивный.
 */
export function reviewStatus(d: ReviewInput): string | null {
  if (d.is_archived) return null;
  const now = new Date();
  // date.today() - локальная дата сервера, не UTC.
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  if (d.effective_to && dayMs(d.effective_to) < today) return 'expired';

  let ref: number | null = d.effective_from ? dayMs(d.effective_from) : null;
  if (ref === null && d.indexed_at) ref = dayMs(d.indexed_at);
  if (ref === null && d.created_at) ref = dayMs(d.created_at);
  return ref !== null && today - ref > YEAR_MS ? 'review_due' : null;
}

// JSON-колонки

/** JSON-поле как список (null -> []). */
export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** JSON-поле как объект (null -> {}). */
export function asDict(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// отдача файлов

// Допустимые строковые значения bool; всё остальное - ошибка валидации.
const TRUE_VALUES = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_VALUES = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

/** Флаг из query-параметра (по умолчанию false) со строгим разбором значения. */
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
 * Необязательный числовой query-параметр.
 * Копия intQuery из lib/messenger.ts: тянуть сюда весь домен мессенджера
 * (а с ним SSE и web-push) ради одной функции разбора - дороже дубля.
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

/** urllib.parse.quote(s) с safe='/' - нужен для Content-Disposition. */
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

// шаблоны документов

/**
 * Для бланка .docx без {{переменных}}
 * отдаётся копия с подставленными названиями авто-полей (кэш
 * docs/templates/.previews), для шаблонов с переменными и pdf - оригинал.
 *
 * Сам рендер живёт в lib/docs/generator.ts. Импорт динамический: lib/docs/*
 * берёт отсюда мелкие утилиты (pyStr), и статическая ссылка замкнула бы цикл
 * модулей; к моменту вызова оба модуля уже инициализированы.
 */
export async function templateDisplayPath(tplId: string, src: string): Promise<string> {
  const { templatePreviewPath } = await import('./docs/generator');
  return templatePreviewPath(tplId, src);
}

/** Потоковая отдача файла с заголовками Content-Type/Length/Disposition. */
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
