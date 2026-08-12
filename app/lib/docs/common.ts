import 'server-only';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';
import { DOCS_DIR, baseName, suffixOf, validationError } from '@/lib/news';

/**
 * Общее для инструментов-мастеров генерации документов (backend/routes/documents.py
 * + services/documents/*): пути, приём загрузок, чтение книг Excel.
 */

/** settings.docs_generated — тот же каталог, куда пишет FastAPI. */
export const GENERATED_DIR = path.join(DOCS_DIR, 'generated');

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** datetime.now().strftime("%Y%m%d_%H%M%S") — локальное время сервера. */
export function timestamp(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}_` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  );
}

/** Кладёт готовый файл в docs/generated и возвращает абсолютный путь. */
export async function saveGenerated(filename: string, content: Buffer): Promise<string> {
  await mkdir(GENERATED_DIR, { recursive: true });
  const out = path.join(GENERATED_DIR, filename);
  await writeFile(out, content);
  return out;
}

/** Ссылки на документ в ответе API — как их формирует routes/documents.py. */
export function docLinks(id: number) {
  return { view_url: `/documents/${id}/view`, download_url: `/api/documents/${id}/download` };
}

// ── приём загрузок ─────────────────────────────────────────────────────────

export interface FormResult {
  form: FormData;
  /** Сырое тело: нужно, чтобы переслать запрос в FastAPI без повторного чтения. */
  raw: ArrayBuffer;
}

/**
 * Разбирает multipart-тело. Тело буферизуем, потому что часть форматов
 * (PDF, старый Office) обслуживает только FastAPI — такой запрос уходит туда
 * целиком, а поток запроса читается лишь один раз.
 */
export async function readForm(
  request: NextRequest,
  field = 'file'
): Promise<FormResult | { response: NextResponse }> {
  const raw = await request.arrayBuffer();
  try {
    const form = await new Response(raw, {
      headers: { 'content-type': request.headers.get('content-type') || '' },
    }).formData();
    return { form, raw };
  } catch {
    return { response: validationError(['body', field], 'missing', 'Field required', null) };
  }
}

/** `file: UploadFile = File(...)` — обязательное поле формы. */
export function requireFile(form: FormData, field = 'file'): File | NextResponse {
  const value = form.get(field);
  if (!(value instanceof File)) {
    return validationError(['body', field], 'missing', 'Field required', null);
  }
  return value;
}

/** Расширение имени загруженного файла в нижнем регистре (Path(...).suffix). */
export function uploadSuffix(file: File): string {
  return suffixOf(baseName(file.name || '')).toLowerCase();
}

/** Значения bool так разбирает pydantic для `Form(default=False)`. */
const TRUE_VALUES = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_VALUES = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

export function boolForm(
  form: FormData,
  field: string
): { value: boolean } | { response: NextResponse } {
  const raw = form.get(field);
  if (raw === null) return { value: false };
  const v = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return { value: true };
  if (FALSE_VALUES.has(v)) return { value: false };
  return {
    response: validationError(
      ['body', field],
      'bool_parsing',
      'Input should be a valid boolean, unable to interpret input',
      raw
    ),
  };
}

/**
 * Сохраняет данные во временный файл и удаляет его после работы —
 * tempfile.mkstemp + os.unlink в Python. Нужен там, где дальше вызывается
 * parseFile (он принимает путь).
 */
export async function withTempFile<T>(
  suffix: string,
  data: Buffer,
  fn: (file: string) => Promise<T>
): Promise<T> {
  const file = path.join(tmpdir(), `hrdoc_${crypto.randomUUID().replace(/-/g, '')}${suffix}`);
  await writeFile(file, data);
  try {
    return await fn(file);
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

// ── чтение книг Excel ──────────────────────────────────────────────────────

/**
 * `str(cell)` как в openpyxl: даты — «YYYY-MM-DD HH:MM:SS», bool — True/False,
 * None — пустая строка.
 */
export function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return (
      `${v.getFullYear()}-${two(v.getMonth() + 1)}-${two(v.getDate())} ` +
      `${two(v.getHours())}:${two(v.getMinutes())}:${two(v.getSeconds())}`
    );
  }
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

/**
 * Книга Excel из буфера. cellDates: иначе даты приходят числами Excel и
 * «13.05.2024» превратится в «45425». SheetJS читает и старый .xls, поэтому
 * конвертация через LibreOffice (как в Python) здесь не нужна.
 */
export function readWorkbook(data: Buffer): XLSX.WorkBook {
  return XLSX.read(data, { type: 'buffer', cellDates: true });
}

/** Первый лист книги — аналог `wb.worksheets[0]` в openpyxl. */
export function firstSheet(wb: XLSX.WorkBook): XLSX.WorkSheet | null {
  const name = wb.SheetNames[0];
  return name ? (wb.Sheets[name] ?? null) : null;
}

/** Активный лист книги — аналог `load_workbook(...).active` в openpyxl. */
export function activeSheet(wb: XLSX.WorkBook): XLSX.WorkSheet | null {
  // В типах SheetJS у WBView объявлен только RTL, хотя activeTab в данных есть.
  const view = wb.Workbook?.Views?.[0] as { activeTab?: number } | undefined;
  const active = view?.activeTab ?? 0;
  const name = wb.SheetNames[active] ?? wb.SheetNames[0];
  return name ? (wb.Sheets[name] ?? null) : null;
}

/**
 * Строки листа как кортежи значений — аналог `ws.iter_rows(values_only=True)`.
 * Пустые ячейки дают null, строки дополняются до ширины листа.
 */
export function sheetRows(ws: XLSX.WorkSheet | null): unknown[][] {
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
  return rows.map((r) => (Array.isArray(r) ? r : []));
}

/** Строки листа, приведённые к строкам (частый случай: `str(c).strip()`). */
export function sheetTextRows(ws: XLSX.WorkSheet | null): string[][] {
  return sheetRows(ws).map((r) => r.map(cellToString));
}

/**
 * Аналог ValueError в сервисах документов: маршрут ловит его и отдаёт 400 с
 * этим же текстом (в Python — `except ValueError as e: HTTPException(400, str(e))`).
 * Прочие исключения дают 500 — как `except Exception`.
 */
export class DocValueError extends Error {}

/** `str(e)` из Python: только текст исключения, без имени класса. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── мелочи, повторяющие поведение Python ───────────────────────────────────

// В Python `\b` и `\w` знают кириллицу, в JS — только ASCII. Тот же приём, что
// в lib/parsers и lib/ml/pipeline: подставляем расширенный класс слова.
const W = '0-9A-Za-zА-Яа-яЁё_';
const B = `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`;

/** Регулярка «как в Python»: \w и \b понимают кириллицу. */
export function ru(pattern: string, flags = ''): RegExp {
  return new RegExp(pattern.replace(/\\b/g, B).replace(/\\w/g, `[${W}]`), flags);
}


/**
 * `round(v, 1)` из Python: половина округляется к чётному, а не «от нуля»
 * (Math.round дал бы 87.3 там, где Python даёт 87.2).
 */
export function round1(v: number): number {
  const scaled = v * 10;
  const fl = Math.floor(scaled);
  const diff = scaled - fl;
  let r: number;
  if (diff > 0.5) r = fl + 1;
  else if (diff < 0.5) r = fl;
  else r = fl % 2 === 0 ? fl : fl + 1;
  return r / 10;
}

/** «Слово, встречающееся чаще всего» — аналог Counter.most_common(1)[0][0]. */
export function mostCommon<T>(values: Iterable<T>): T | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestN = -1;
  // Map хранит порядок вставки — при равенстве побеждает первый встреченный,
  // как у Counter.most_common.
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}
