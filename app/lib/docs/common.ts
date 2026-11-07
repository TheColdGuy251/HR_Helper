import 'server-only';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';
import type { document_generator } from '@prisma/client';
import { DOCS_DIR, baseName, suffixOf, validationError } from '@/lib/news';

/** Общее для мастеров генерации документов: пути, приём загрузок, чтение книг Excel. */

/** Каталог сгенерированных документов. */
export const GENERATED_DIR = path.join(DOCS_DIR, 'generated');

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** datetime.now().strftime("%Y%m%d_%H%M%S") - локальное время сервера. */
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

/** Ссылки на документ в ответе API. */
export function docLinks(id: string) {
  return { view_url: `/documents/${id}/view`, download_url: `/api/documents/${id}/download` };
}

/** Поля my_documents, из которых складывается template_key (см. documentTemplateKey). */
export const DOCUMENT_KIND_SELECT = {
  generator: true,
  template: { select: { key: true } },
} as const;

/**
 * template_key документа в ответах API: ключ шаблона из doc_templates или имя
 * встроенного генератора. В БД это две колонки - generator и template_id.
 */
export function documentTemplateKey(d: {
  generator: document_generator;
  template?: { key: string } | null;
}): string | null {
  return d.generator === 'template' ? (d.template?.key ?? null) : d.generator;
}

// приём загрузок

export interface FormResult {
  form: FormData;
  /** Сырое тело запроса: поток читается только один раз. */
  raw: ArrayBuffer;
}

/**
 * Разбирает multipart-тело. Тело буферизуется целиком: поток запроса читается
 * только один раз.
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

/** `file: UploadFile = File(...)` - обязательное поле формы. */
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

/** Строковые значения bool для полей формы (по умолчанию false). */
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
 * Сохраняет данные во временный файл и удаляет его после работы. Нужен там,
 * где дальше вызывается parseFile (он принимает путь).
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

// чтение книг Excel

/**
 * Ячейка строкой: даты - "YYYY-MM-DD HH:MM:SS", bool - True/False,
 * null - пустая строка.
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
 * "13.05.2024" превратится в "45425". SheetJS читает и старый .xls, поэтому
 * конвертация через LibreOffice здесь не нужна.
 */
export function readWorkbook(data: Buffer): XLSX.WorkBook {
  return XLSX.read(data, { type: 'buffer', cellDates: true });
}

/** Первый лист книги. */
export function firstSheet(wb: XLSX.WorkBook): XLSX.WorkSheet | null {
  const name = wb.SheetNames[0];
  return name ? (wb.Sheets[name] ?? null) : null;
}

/** Активный лист книги. */
export function activeSheet(wb: XLSX.WorkBook): XLSX.WorkSheet | null {
  // В типах SheetJS у WBView объявлен только RTL, хотя activeTab в данных есть.
  const view = wb.Workbook?.Views?.[0] as { activeTab?: number } | undefined;
  const active = view?.activeTab ?? 0;
  const name = wb.SheetNames[active] ?? wb.SheetNames[0];
  return name ? (wb.Sheets[name] ?? null) : null;
}

/**
 * Строки листа как кортежи значений - аналог `ws.iter_rows(values_only=True)`.
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
 * Ошибка входных данных в сервисах документов: маршрут отдаёт 400 с этим
 * текстом. Прочие исключения дают 500.
 */
export class DocValueError extends Error {}

/** Текст ошибки без имени класса. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Вспомогательные функции

// В JS `\b` и `\w` знают только ASCII, поэтому, как в lib/parsers и
// lib/ml/pipeline, подставляем расширенный класс слова.
const W = '0-9A-Za-zА-Яа-яЁё_';
const B = `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`;

/** Регулярка "": \w и \b понимают кириллицу. */
export function ru(pattern: string, flags = ''): RegExp {
  return new RegExp(pattern.replace(/\\b/g, B).replace(/\\w/g, `[${W}]`), flags);
}

/**
 * Округление до 0.1 с половиной к чётному (банковское), а не от нуля, как
 * Math.round: 87.25 -> 87.2.
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

/** "Слово, встречающееся чаще всего" - аналог Counter.most_common(1)[0][0]. */
export function mostCommon<T>(values: Iterable<T>): T | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestN = -1;
  // Map хранит порядок вставки - при равенстве побеждает первый встреченный,
  // как у Counter.most_common.
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}
