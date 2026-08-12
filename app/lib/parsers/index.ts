import 'server-only';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';
import * as XLSX from 'xlsx';
import { baseName, stemOf, suffixOf } from '../news';
import { ocrImageBytes, ocrPdfPages } from './ocr';
import { convertToModern } from './office-convert';

/**
 * Извлечение текста из файлов — порт backend/services/parsers/*.py
 * (dispatch.py, base.py, docx.py, xlsx.py, pptx.py, plain.py, rtf.py, pdf.py,
 * ocr.py, office_convert.py, xls.py).
 *
 * ЧТО РАЗБИРАЕТСЯ ЗДЕСЬ, В NEXT:
 *   .docx           — mammoth (HTML → абзацы + таблицы с разметкой столбцов);
 *   .xlsx / .xlsm   — SheetJS, все листы, блок «Лист: <имя>» на лист;
 *   .xls            — SheetJS читает и старый BIFF (в Python это xlrd);
 *   .pptx           — распаковка zip + разбор XML слайдов (текст фигур,
 *                     таблицы, заметки докладчика);
 *   .txt .md .rst .csv .log — чтение файла как UTF-8;
 *   .rtf            — снятие управляющих последовательностей (мини-порт striprtf);
 *   .pdf            — постраничный текст через unpdf (pdf.js), пустые страницы
 *                     дораспознаются OCR (см. lib/parsers/ocr.ts);
 *   изображения     — Tesseract (.png .jpg .jpeg .webp .bmp .tif .tiff);
 *   .doc .odt .ods .ppt .odp — конвертация LibreOffice в docx/xlsx/pptx.
 *
 * ОТЛИЧИЯ ОТ PYTHON (осознанные):
 *  - .docx: не извлекаются текст-боксы, фигуры и SmartArt (в Python по ним
 *    реконструируется схема процесса «по стрелкам»); колонтитулы тоже не
 *    читаются — mammoth отдаёт только тело документа;
 *  - PDF-сканы: PyMuPDF рендерит страницу целиком (get_pixmap), pdf.js так не
 *    умеет без нативного canvas — берём самую крупную вложенную в страницу
 *    картинку. Для сканов это и есть страница, но у «смешанных» страниц
 *    (вектор + картинки) OCR увидит только картинку.
 */

// ── Юникод-регэкспы ────────────────────────────────────────────────────────
// В Python `\b` и `\w` знают кириллицу, в JS — только ASCII. Тот же приём, что
// в lib/ml/pipeline.ts: подставляем расширенный класс слова и границу слова.

const W = '0-9A-Za-zА-Яа-яЁё_';
const B = `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`;

function ru(pattern: string, flags = ''): RegExp {
  return new RegExp(pattern.replace(/\\b/g, B).replace(/\\w/g, `[${W}]`), flags);
}

/** str.isalpha() для одного символа. */
export function isAlphaChar(c: string): boolean {
  return /\p{L}/u.test(c);
}

/** str.isupper() для одного символа (Lu и Lt, как в Python). */
function isUpperChar(c: string): boolean {
  return /\p{Lu}|\p{Lt}/u.test(c);
}

/** str.split() без аргументов: режет по любым пробелам, пустые отбрасывает. */
function pySplit(s: string): string[] {
  return s.split(/\s+/).filter((x) => x !== '');
}

/** str.strip(chars): снимает с обоих концов любые символы из набора. */
function stripChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start += 1;
  while (end > start && chars.includes(s[end - 1])) end -= 1;
  return s.slice(start, end);
}

// ── Результат разбора ──────────────────────────────────────────────────────

export interface ParsedMeta {
  /** ParsedDocument.title — имя файла без расширения либо название из шапки. */
  title: string;
  /** ParsedDocument.source_uri — абсолютный путь к файлу. */
  source_uri: string;
  /** local | web | upload */
  source_type: string;
  mime_type: string | null;
  pages: number;
  /** ParsedDocument.extra: filename, ocr_applied, pii_warning и т.п. */
  extra: Record<string, unknown>;
  /**
   * true — формат не разбирается здесь. Сейчас parseFile такого не возвращает
   * (все форматы из ALLOWED поддержаны), поле оставлено как контракт для
   * вызывающих: индексатор на нём завершает документ статусом failed.
   */
  unsupported?: boolean;
  /** Человекочитаемая причина, почему формат не разобран. */
  reason?: string;
}

export interface ParsedFile {
  text: string;
  meta: ParsedMeta;
}

function meta(
  file: string,
  mimeType: string | null,
  overrides: Partial<ParsedMeta> = {}
): ParsedMeta {
  return {
    title: stemOf(baseName(file)),
    source_uri: file,
    source_type: 'local',
    mime_type: mimeType,
    pages: 0,
    extra: {},
    ...overrides,
  };
}

// ── base.py: format_table ──────────────────────────────────────────────────

/**
 * Сериализует таблицу с СОХРАНЕНИЕМ связи строка↔столбец: первая строка —
 * заголовки, каждая строка данных размечается метками колонок
 * («Должность: Бухгалтер; Оклад: 60000»). Порт format_table.
 */
export function formatTable(rows: string[][]): string[] {
  const cleaned: string[][] = [];
  for (const row of rows) {
    const cells = row.map((c) => (c || '').trim());
    if (cells.some((c) => c !== '')) cleaned.push(cells);
  }
  if (!cleaned.length) return [];

  const ncols = Math.max(...cleaned.map((r) => r.length));
  for (const r of cleaned) while (r.length < ncols) r.push('');

  // Нечего размечать — отдаём построчно через « | »
  if (cleaned.length < 2 || ncols < 2) {
    return cleaned.map((r) => r.filter((c) => c).join(' | '));
  }

  const header = cleaned[0];
  const out = ['Таблица — столбцы: ' + header.filter((h) => h).join(' | ')];
  for (const r of cleaned.slice(1)) {
    const pairs: string[] = [];
    r.forEach((cell, i) => {
      if (!cell) return;
      const label = i < header.length && header[i] ? header[i] : `столбец ${i + 1}`;
      pairs.push(`${label}: ${cell}`);
    });
    if (pairs.length) out.push(pairs.join('; '));
  }
  return out;
}

// ── base.py: derive_title ──────────────────────────────────────────────────

// Сильные «имена» документов (само название) vs слабые ссылки (на утверждающий
// акт). «ПОЛОЖЕНИЕ» важнее, чем «Приказом № 5», которым оно утверждено.
const TITLE_STRONG = [
  'положени', 'инструкци', 'регламент', 'правил', 'порядок', 'кодекс', 'устав',
  'договор', 'соглашени', 'методическ', 'стандарт', 'политик', 'руководств',
  'памятк', 'перечень', 'штатн',
];
const TITLE_STRONG_RE = ru(`\\b(${TITLE_STRONG.join('|')})`, 'iu');
// Слабые — только если строка С НИХ начинается (именительный: «ПРИКАЗ № 5 …»),
// чтобы не цеплять ссылку «Приказом № 5» под «УТВЕРЖДЕНО».
const TITLE_WEAK_RE = ru('^(приказ|распоряжение)\\b', 'iu');
const TITLE_CONT_RE = ru('^(о|об|по|для|при)\\b', 'iu');
const TITLE_SKIP_RE = /^(утвержд|согласован|приложени|г\.|№|\p{Nd})/iu;

function cleanTitle(s: string): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return stripChars(collapsed, '«»"\'').trim().slice(0, 200);
}

/** Приклеивает продолжение названия со следующей строки («об оплате труда»). */
function withContinuation(lines: string[], i: number): string {
  let title = lines[i];
  if (i + 1 < lines.length && TITLE_CONT_RE.test(lines[i + 1]) && title.length < 120) {
    title = `${title} ${lines[i + 1]}`;
  }
  return cleanTitle(title);
}

/**
 * Извлекает человекочитаемое название из шапки документа («ПОЛОЖЕНИЕ об оплате
 * труда»). Иначе — fallback (имя файла). Порт derive_title: улучшает и
 * цитирование, и разрешение doc_hint при множестве документов.
 */
export function deriveTitle(text: string, fallback = ''): string {
  const lines = (text || '')
    .split('\n')
    .map((ln) => ln.trim())
    .filter((ln) => ln)
    .slice(0, 8);

  // 1) Сильное название документа
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (ln.length >= 8 && ln.length <= 200 && !TITLE_SKIP_RE.test(ln) && TITLE_STRONG_RE.test(ln)) {
      return withContinuation(lines, i);
    }
  }

  // 2) Заголовок КАПСОМ в шапке
  for (const ln of lines) {
    const letters = Array.from(ln).filter(isAlphaChar);
    if (letters.length && ln.length >= 8 && ln.length <= 120 && pySplit(ln).length >= 2) {
      const upper = letters.filter(isUpperChar).length;
      if (upper / letters.length >= 0.8 && !TITLE_SKIP_RE.test(ln)) return cleanTitle(ln);
    }
  }

  // 3) Слабое: документ-приказ (именительный в начале строки)
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (ln.length >= 8 && ln.length <= 200 && TITLE_WEAK_RE.test(ln)) {
      return withContinuation(lines, i);
    }
  }

  return fallback;
}

// ── Общие XML/HTML-утилиты ─────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : full;
    }
    return ENTITIES[code] ?? full;
  });
}

/** Текст всех <a:t> внутри фрагмента (OOXML DrawingML). */
function drawingText(fragment: string): string {
  let out = '';
  for (const m of fragment.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) {
    out += unescapeXml(m[1]);
  }
  return out;
}

// ── plain.py ───────────────────────────────────────────────────────────────

const PLAIN_EXTS = new Set(['.txt', '.md', '.rst', '.csv', '.log']);

async function parseTextFile(file: string): Promise<ParsedFile> {
  // errors="ignore" в Python: битые байты просто выпадают. Node подставляет
  // U+FFFD — убираем его, чтобы результат совпадал.
  const raw = await readFile(file, 'utf8');
  return { text: raw.replace(/�/g, ''), meta: meta(file, 'text/plain') };
}

// ── docx.py (через mammoth) ────────────────────────────────────────────────

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface HtmlBlocks {
  paragraphs: string[];
  tables: string[][][];
}

const BLOCK_OPEN_RE = /^(p|h[1-6]|li)$/;

/**
 * Разбирает HTML от mammoth на абзацы и таблицы. Порядок как у python-docx:
 * сначала все абзацы тела, затем все таблицы (doc.paragraphs не видит ячейки).
 */
function htmlBlocks(html: string): HtmlBlocks {
  const paragraphs: string[] = [];
  const tables: string[][][] = [];

  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string[] | null = null; // абзацы внутри ячейки
  let buf = '';
  let inBlock = false;

  const flushBlock = () => {
    // python-docx отдаёт текст абзаца как есть, без схлопывания пробелов.
    const text = buf.replace(/[ \t]+\n/g, '\n').trim();
    buf = '';
    inBlock = false;
    if (!text) return;
    if (cell) cell.push(text);
    else paragraphs.push(text);
  };

  const tokens = html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>|[^<]+/g);
  for (const t of tokens) {
    const chunk = t[0];
    if (chunk[0] !== '<') {
      if (inBlock) buf += unescapeXml(chunk);
      continue;
    }
    const tag = (t[1] || '').toLowerCase();
    const closing = chunk[1] === '/';

    if (tag === 'br') {
      // python-docx превращает <w:br> в перевод строки внутри абзаца.
      if (inBlock) buf += '\n';
      continue;
    }
    if (tag === 'table') {
      if (closing) {
        if (table) tables.push(table);
        table = null;
      } else {
        table = [];
      }
      continue;
    }
    if (tag === 'tr') {
      if (closing) {
        if (table && row) table.push(row);
        row = null;
      } else {
        row = [];
      }
      continue;
    }
    if (tag === 'td' || tag === 'th') {
      if (closing) {
        if (inBlock) flushBlock();
        // Несколько абзацев в ячейке python-docx склеивает через \n.
        if (row) row.push((cell || []).join('\n'));
        cell = null;
      } else {
        cell = [];
      }
      continue;
    }
    if (BLOCK_OPEN_RE.test(tag)) {
      if (closing) flushBlock();
      else {
        if (inBlock) flushBlock();
        inBlock = true;
      }
      continue;
    }
    // Инлайновые теги (strong, em, a, sup…) — текст внутри уже придёт отдельным
    // токеном, сам тег игнорируем.
  }
  if (inBlock) flushBlock();

  return { paragraphs, tables };
}

async function parseDocx(file: string): Promise<ParsedFile> {
  const mammoth = (await import('mammoth')).default;
  const { value: html } = await mammoth.convertToHtml({ path: file });
  const { paragraphs, tables } = htmlBlocks(html);

  const parts = [...paragraphs];
  for (const rows of tables) parts.push(...formatTable(rows));

  return { text: parts.join('\n\n'), meta: meta(file, DOCX_MIME) };
}

// ── xlsx.py (через SheetJS) ────────────────────────────────────────────────

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** `str(cell)` как в openpyxl: даты — «YYYY-MM-DD HH:MM:SS», bool — True/False. */
function cellToString(v: unknown): string {
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

/** Общий обход листов книги: блок «Лист: <имя>» + размеченные строки таблицы. */
function workbookText(wb: XLSX.WorkBook, toString: (v: unknown) => string): string {
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    const rows = raw.map((r) => (Array.isArray(r) ? r.map(toString) : []));
    const lines = formatTable(rows);
    if (lines.length) {
      parts.push(`Лист: ${name}`);
      parts.push(...lines);
    }
  }
  return parts.join('\n\n');
}

async function parseXlsx(file: string): Promise<ParsedFile> {
  const buf = await readFile(file);
  // cellDates: иначе даты приходят числами Excel и «13.05.2024» станет «45425».
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  return { text: workbookText(wb, cellToString), meta: meta(file, XLSX_MIME) };
}

// ── xls.py (старый BIFF, тоже через SheetJS) ───────────────────────────────

const XLS_MIME = 'application/vnd.ms-excel';

/** `str(cell)` как в xlrd: числа — float (целые печатаем без «.0»), bool — 0/1. */
function xlsCellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v).trim();
}

/**
 * Нативный парсер старого Excel .xls (без LibreOffice). В Python это xlrd,
 * здесь — тот же SheetJS: он читает и BIFF. cellDates не включаем, чтобы даты
 * оставались числами, как их отдаёт xlrd.
 */
async function parseXls(file: string): Promise<ParsedFile> {
  const buf = await readFile(file);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  return { text: workbookText(wb, xlsCellToString), meta: meta(file, XLS_MIME) };
}

// ── pptx.py (распаковка zip + XML) ─────────────────────────────────────────

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Текст абзаца <a:p>: только прогоны <a:r>, как у python-pptx `para.runs`. */
function pptxParagraphText(xml: string): string {
  let out = '';
  for (const r of xml.matchAll(/<a:r(?:\s[^>]*)?>([\s\S]*?)<\/a:r>/g)) out += drawingText(r[1]);
  return out.trim();
}

/** Строки таблицы <a:tbl>: ряды <a:tr>, ячейки <a:tc>. */
function pptxTableRows(xml: string): string[][] {
  const rows: string[][] = [];
  for (const tr of xml.matchAll(/<a:tr(?:\s[^>]*)?>([\s\S]*?)<\/a:tr>/g)) {
    const cells: string[] = [];
    for (const tc of tr[1].matchAll(/<a:tc(?:\s[^>]*)?>([\s\S]*?)<\/a:tc>/g)) {
      const paras: string[] = [];
      for (const p of tc[1].matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
        paras.push(pptxParagraphText(p[1]));
      }
      cells.push(paras.join('\n').trim());
    }
    rows.push(cells);
  }
  return rows;
}

/** Номер слайда из имени части: ppt/slides/slide12.xml → 12. */
function slideOrder(name: string): number {
  const m = /(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

async function parsePptx(file: string): Promise<ParsedFile> {
  const zip = new PizZip(await readFile(file));
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideOrder(a) - slideOrder(b));

  const parts: string[] = [];
  slides.forEach((name, i) => {
    const xml = zip.files[name].asText();
    const slideParts: string[] = [];

    // Таблицы и абзацы собираем В ПОРЯДКЕ следования в XML: у python-pptx это
    // порядок фигур на слайде, важный для схем процессов.
    const tableSpans: [number, number, string][] = [];
    for (const m of xml.matchAll(/<a:tbl(?:\s[^>]*)?>[\s\S]*?<\/a:tbl>/g)) {
      tableSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length, m[0]]);
    }
    const items: [number, 'table' | 'para', string][] = tableSpans.map(([s, , frag]) => [
      s,
      'table',
      frag,
    ]);
    for (const m of xml.matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g)) {
      const at = m.index ?? 0;
      // Абзацы внутри таблицы уже учтены в самой таблице.
      if (tableSpans.some(([s, e]) => at >= s && at < e)) continue;
      items.push([at, 'para', m[0]]);
    }
    items.sort((a, b) => a[0] - b[0]);

    for (const [, kind, frag] of items) {
      if (kind === 'table') slideParts.push(...formatTable(pptxTableRows(frag)));
      else {
        const text = pptxParagraphText(frag);
        if (text) slideParts.push(text);
      }
    }

    // Заметки докладчика — часто содержат пояснения к схеме. Связь слайда с
    // заметками лежит в его .rels (имена файлов не обязаны совпадать).
    const rels = zip.files[`ppt/slides/_rels/${path.posix.basename(name)}.rels`];
    if (rels) {
      const target = /Target="([^"]*notesSlide\d+\.xml)"/.exec(rels.asText());
      const notesName = target
        ? path.posix.normalize(`ppt/slides/${target[1]}`).replace(/^\.\//, '')
        : null;
      const notesFile = notesName ? zip.files[notesName] : undefined;
      if (notesFile) {
        const notesXml = notesFile.asText();
        const lines: string[] = [];
        for (const p of notesXml.matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g)) {
          lines.push(pptxParagraphText(p[0]));
        }
        const notes = lines.join('\n').trim();
        if (notes) slideParts.push(`Заметки: ${notes}`);
      }
    }

    if (slideParts.length) {
      parts.push(`Слайд ${i + 1}`);
      parts.push(...slideParts);
    }
  });

  return { text: parts.join('\n\n'), meta: meta(file, PPTX_MIME) };
}

// ── rtf.py (мини-порт striprtf) ────────────────────────────────────────────

// Группы, содержимое которых не является текстом документа.
const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable',
  'info', 'pict', 'object', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'rsidtbl', 'generator', 'xmlnstbl', 'filetbl', 'mmathPr',
  'operator', 'company', 'author', 'title', 'subject', 'keywords', 'comment',
  'creatim', 'revtim', 'printim', 'buptim', 'doccomm', 'nonshppict',
]);

// Управляющие слова, которые превращаются в символы.
const RTF_SPECIALS: Record<string, string> = {
  par: '\n', sect: '\n\n', page: '\n\n', line: '\n', tab: '\t', cell: ' ',
  row: '\n', lquote: '‘', rquote: '’', ldblquote: '“',
  rdblquote: '”', bullet: '•', endash: '–', emdash: '—',
  emspace: ' ', enspace: ' ', qmspace: ' ', '~': ' ', '-': '', _: '‑',
};

function decodeBytes(bytes: number[], codepage: number): string {
  const buf = Buffer.from(bytes);
  try {
    return new TextDecoder(`windows-${codepage}`).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

/**
 * Снимает управляющие последовательности RTF. Кириллица в RTF хранится как
 * \\'xx с кодовой страницей из \\ansicpgNNNN (обычно 1251) либо как \\uNNNN.
 */
export function rtfToText(raw: Buffer): string {
  // latin1 сохраняет байты один-в-один — управляющие последовательности ASCII
  // остаются нетронутыми, а высокие байты потом декодируем кодовой страницей.
  const src = raw.toString('latin1');
  const cpMatch = /\\ansicpg(\d+)/.exec(src);
  const codepage = cpMatch ? Number(cpMatch[1]) : 1251;

  const out: string[] = [];
  let hexBuf: number[] = [];
  const flushHex = () => {
    if (hexBuf.length) {
      out.push(decodeBytes(hexBuf, codepage));
      hexBuf = [];
    }
  };

  // Состояние группы: сколько символов пропустить после \\uN (ucN) и надо ли
  // выбрасывать текст всей группы (служебная destination).
  const stack: { uc: number; skip: boolean }[] = [{ uc: 1, skip: false }];
  let ignorable = false; // следующая группа помечена \\*
  let skipChars = 0;

  const TOKEN =
    /\\([a-zA-Z]{1,32})(-?\d{1,10})?[ ]?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|[\r\n]+|([\s\S])/g;

  for (const m of src.matchAll(TOKEN)) {
    // Совпала только одна из альтернатив — остальные группы undefined.
    const [, word, arg, hex, symbol, brace, char] = m as unknown as (string | undefined)[];
    const top = stack[stack.length - 1];

    if (brace) {
      flushHex();
      if (brace === '{') {
        stack.push({ uc: top.uc, skip: top.skip });
        ignorable = false;
      } else if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    if (hex !== undefined) {
      if (top.skip) continue;
      if (skipChars > 0) {
        skipChars -= 1;
        continue;
      }
      hexBuf.push(Number.parseInt(hex, 16));
      continue;
    }
    flushHex();

    if (word !== undefined) {
      if (word === 'uc') {
        top.uc = Math.max(0, Number(arg ?? 1));
        continue;
      }
      if (word === 'u') {
        const code = Number(arg ?? 0);
        if (!top.skip) out.push(String.fromCodePoint(code < 0 ? code + 65536 : code));
        skipChars = top.uc;
        continue;
      }
      if (RTF_SKIP_DESTINATIONS.has(word)) {
        top.skip = true;
        ignorable = false;
        continue;
      }
      if (ignorable) {
        top.skip = true;
        ignorable = false;
        continue;
      }
      if (!top.skip && Object.prototype.hasOwnProperty.call(RTF_SPECIALS, word)) {
        out.push(RTF_SPECIALS[word]);
      }
      continue;
    }

    if (symbol !== undefined) {
      if (symbol === '*') {
        ignorable = true;
        continue;
      }
      if (!top.skip) {
        // \\\\ \\{ \\} — экранированные литералы; \\~ и прочие — из таблицы.
        out.push(RTF_SPECIALS[symbol] ?? symbol);
      }
      continue;
    }

    if (char !== undefined) {
      if (top.skip) continue;
      if (skipChars > 0) {
        skipChars -= 1;
        continue;
      }
      // Одиночный высокий байт вне \\'xx — тоже текст в кодовой странице.
      const code = char.charCodeAt(0);
      out.push(code > 127 ? decodeBytes([code], codepage) : char);
      continue;
    }
    // Переводы строк самого RTF-файла разметкой не являются.
  }
  flushHex();

  return out.join('');
}

async function parseRtf(file: string): Promise<ParsedFile> {
  const text = rtfToText(await readFile(file)).trim();
  return {
    text,
    meta: meta(file, 'application/rtf', { title: deriveTitle(text, stemOf(baseName(file))) }),
  };
}

// ── pdf.py (unpdf = pdf.js) ────────────────────────────────────────────────

const PDF_MIME = 'application/pdf';

/** settings.ocr_min_chars_per_page: меньше символов на странице — считаем сканом. */
function ocrMinCharsPerPage(): number {
  const raw = Number(process.env.OCR_MIN_CHARS_PER_PAGE);
  return Number.isFinite(raw) && raw > 0 ? raw : 80;
}

async function parsePdf(file: string): Promise<ParsedFile> {
  const { extractText, getDocumentProxy, getMeta } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = [...text];

  // Решаем по странице, нужен ли OCR
  const minChars = ocrMinCharsPerPage();
  const ocrTargets: number[] = [];
  pages.forEach((page, i) => {
    if ((page || '').trim().length < minChars) ocrTargets.push(i);
  });

  if (ocrTargets.length) {
    console.info(`PDF ${baseName(file)}: запускаю OCR для ${ocrTargets.length} стр.`);
    try {
      const recognized = await ocrPdfPages(pdf, ocrTargets);
      for (const [i, txt] of recognized) {
        if (txt && txt.trim()) pages[i] = txt;
      }
    } catch (e) {
      console.warn(`OCR не выполнен (${baseName(file)}): ${e instanceof Error ? e.message : e}`);
    }
  }

  const fullText = pages.map((p) => (p || '').trim()).filter((p) => p).join('\n\n');
  const info = (await getMeta(pdf).catch(() => null))?.info ?? {};
  const stem = stemOf(baseName(file));
  return {
    text: fullText,
    meta: meta(file, PDF_MIME, {
      title: (info.Title as string) || stem,
      pages: pages.length,
      // ocr_applied — был ли распознан хотя бы один скан-лист (для двойного
      // предпросмотра «оригинал + извлечённый текст» в /kb).
      extra: { author: info.Author ?? null, ocr_applied: ocrTargets.length > 0 },
    }),
  };
}

// ── dispatch.py: изображения и старый Office ───────────────────────────────

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);

/** Изображение → текст через OCR (содержимое фото документа/скана). */
async function parseImage(file: string): Promise<ParsedFile> {
  const data = await readFile(file);
  let text = '';
  try {
    text = (await ocrImageBytes(data)) || '';
  } catch {
    text = '';
  }
  const ext = suffixOf(baseName(file)).toLowerCase().replace(/^\./, '') || 'png';
  return {
    text: text.trim(),
    meta: meta(file, `image/${ext}`, {
      source_type: 'upload',
      extra: { ocr_applied: true }, // изображение всегда распознаётся через OCR
    }),
  };
}

/**
 * Конвертирует старый формат в docx/xlsx/pptx (LibreOffice) и парсит результат.
 * Метаданные (source_uri, title) сохраняем по ОРИГИНАЛЬНОМУ файлу.
 */
async function parseLegacyOffice(file: string): Promise<ParsedFile> {
  const converted = await convertToModern(file);
  try {
    const ext = suffixOf(baseName(converted)).toLowerCase();
    const parsed =
      ext === '.docx'
        ? await parseDocx(converted)
        : ext === '.pptx'
          ? await parsePptx(converted)
          : await parseXlsx(converted);
    return {
      text: parsed.text,
      meta: {
        ...parsed.meta,
        source_uri: file,
        title: parsed.meta.title || stemOf(baseName(file)),
        mime_type: null,
      },
    };
  } finally {
    // Временный каталог конвертации — целиком наш, удаляем вместе с профилем.
    await rm(path.dirname(converted), { recursive: true, force: true });
  }
}

/**
 * Пробуем чистый JS-парсер; если он упал или дал пустой текст —
 * откатываемся на конвертацию через LibreOffice (когда он доступен).
 */
async function tryNative(
  parser: (file: string) => Promise<ParsedFile>,
  file: string
): Promise<ParsedFile> {
  try {
    const parsed = await parser(file);
    if (parsed.text.trim()) return parsed;
    console.info(`${baseName(file)}: нативный парсер дал пустой текст — пробую LibreOffice`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.info(`${baseName(file)}: нативный парсер не смог (${msg}) — пробую LibreOffice`);
  }
  return parseLegacyOffice(file);
}

// ── dispatch.py ────────────────────────────────────────────────────────────

/**
 * Форматы, которые Next разбирает сам. Совпадает со списком parse_file:
 * PDF и OCR идут через unpdf/Tesseract, старый Office — через LibreOffice.
 */
export const NATIVE_EXTS = new Set([
  '.pdf', '.docx', '.xlsx', '.xlsm', '.pptx', '.rtf', '.xls',
  '.doc', '.odt', '.ods', '.ppt', '.odp',
  ...IMAGE_EXTS, ...PLAIN_EXTS,
]);

/** Разбирается ли расширение силами Next (иначе файл нужно отдать в FastAPI). */
export function isNativelyParsable(ext: string): boolean {
  return NATIVE_EXTS.has(ext.toLowerCase());
}

/** Единая точка входа: файл → текст и метаданные. Порт parse_file из dispatch.py. */
export async function parseFile(filePath: string): Promise<ParsedFile> {
  const file = path.resolve(filePath);
  const ext = suffixOf(baseName(file)).toLowerCase();

  if (ext === '.pdf') return parsePdf(file);
  if (ext === '.docx') return parseDocx(file);
  if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(file);
  if (ext === '.pptx') return parsePptx(file);
  if (PLAIN_EXTS.has(ext)) return parseTextFile(file);
  if (IMAGE_EXTS.has(ext)) return parseImage(file);
  // .rtf и .xls читаем НАТИВНО (без LibreOffice); при неудаче — откат на конвертацию.
  if (ext === '.rtf') return tryNative(parseRtf, file);
  if (ext === '.xls') return tryNative(parseXls, file);
  // Прочие старые форматы (.doc/.odt/.ods/.ppt/.odp) → LibreOffice.
  if (ext === '.doc' || ext === '.odt' || ext === '.ods' || ext === '.ppt' || ext === '.odp') {
    return parseLegacyOffice(file);
  }
  throw new Error(`Неподдерживаемый формат: ${ext}`);
}
