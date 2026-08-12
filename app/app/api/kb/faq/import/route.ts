import crypto, { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, requireKbEditor } from '@/lib/auth';
import { baseName, suffixOf, validationError } from '@/lib/news';
import { convertToModern } from '@/lib/parsers/office-convert';
import { invalidateFaqMatcher } from '@/lib/ml/faq';
import { bodyTables, loadDocxBody, tableRows } from '../../_docx';

// Полный реимпорт FAQ отдела кадров из таблиц «чат-бот …».
// Порт POST /api/kb/faq/import из backend/routes/kb.py (import_faq) и
// backend/services/rag/faq.py (_rows_from_file, _group_rows, import_faq_files).
//
// ВНИМАНИЕ: заменяет ВСЕ существующие записи, включая ручные правки.
//
// Статический сегмент «import» перекрывает динамический [entry_id] — иначе
// импорт попал бы в обработчик правки записи (см. комментарий там же).
//
// ЭМБЕДДИНГ-ИНДЕКС ВАРИАНТОВ: после реимпорта сбрасываем прогретые прототипы
// FAQ-матчера (аналог get_matcher().invalidate()) — иначе бот продолжит
// отвечать по старым формулировкам. Кэш матчера в процессе FastAPI, если тот
// ещё поднят, сбросит уже сам Python-роут.

const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Форматы, которые Python принимает у import_faq. */
const PY_EXTS = new Set(['.docx', '.doc']);
/** Таблицы FAQ, набранные в Excel/Calc: Python их отвергает, мы читаем через SheetJS. */
const SHEET_EXTS = new Set(['.xlsx', '.xlsm', '.xls', '.ods']);

// ── Утилиты из services/rag/faq.py ─────────────────────────────────────────

/** _norm: схлопывает пробелы. */
function norm(s: string): string {
  return (s || '').trim().replace(/\s+/g, ' ');
}

// str.splitlines() режет строки шире, чем «\n»: в ячейках Word встречаются
// вертикальная табуляция (мягкий перенос строки) и разрыв страницы.
const LINE_BREAK_RE = new RegExp('\\r\\n|[\\n\\r\\v\\f\\u0085\\u2028\\u2029]');

/** Порт str.splitlines(). */
function splitLines(s: string): string[] {
  return (s || '').split(LINE_BREAK_RE);
}

/** _lines: непустые строки ячейки без прочерков. */
function lines(cell: string): string[] {
  const out: string[] = [];
  for (const x of splitLines(cell)) {
    const n = norm(x);
    if (n && n !== '-') out.push(n);
  }
  return out;
}

const QUESTION_PREFIXES = ['какой', 'какая', 'какие', 'что', 'уточните'];

function looksLikeQuestion(s: string): boolean {
  const low = s.toLowerCase();
  // «интересует» — устойчивый оборот уточняющих вопросов в таблицах УРП
  // («Аттестация какой категории работников интересует»): знака «?» в них нет,
  // а вопросительное слово стоит в середине фразы.
  return (
    s.includes('?') ||
    QUESTION_PREFIXES.some((p) => low.startsWith(p)) ||
    low.includes('интересует')
  );
}

/** str.rstrip("."): снимает точки в конце. */
function rstripDots(s: string): string {
  return s.replace(/\.+$/, '');
}

/** Строки колонки ссылок, в которых есть хоть буква или цифра: обрезки
 *  вёрстки вроде одиночной «)» карточкой не становятся. */
function refLines(cell: string): string[] {
  return lines(cell).filter((l) => /[\p{L}\p{N}]/u.test(l));
}

// ── Контакт подразделения ──────────────────────────────────────────────────
// В исходных таблицах контакт — «Отдел … (ссылка на телефонный справочник)»:
// пометка в скобках адресована разработчику и означает гиперссылку на
// телефонный справочник ТИУ (протокол встречи 03.07). Объединённые ячейки
// вдобавок дублируют текст построчно — дубли убираем.

const PHONEBOOK_URL = 'https://www.tyuiu.ru/phones/';
const PHONEBOOK_NOTE = /\(\s*ссылк\w*[^)]*телефонн\w*[^)]*справочник\w*[^)]*\)/i;

function contactFromCell(cell: string): string | null {
  const uniq = [...new Set(lines(cell))];
  const parts = uniq.map((line) => {
    if (!PHONEBOOK_NOTE.test(line)) return rstripDots(line);
    const name = rstripDots(norm(line.replace(new RegExp(PHONEBOOK_NOTE.source, 'gi'), ' ')));
    return name
      ? `[${name}](${PHONEBOOK_URL})`
      : `[Телефонный справочник](${PHONEBOOK_URL})`;
  });
  const joined = parts.filter(Boolean).join('; ');
  return joined || null;
}

/**
 * _group_rows: одинаковые непустые варианты (объединённая ячейка) или пустые
 * варианты при том же блоке — продолжение группы.
 */
function groupRows(rows: string[][]): string[][][] {
  const groups: string[][][] = [];
  for (const cells of rows) {
    const block = norm(cells[1]);
    const variants = lines(cells[2]);
    if (groups.length) {
      const prev = groups[groups.length - 1][groups[groups.length - 1].length - 1];
      const prevBlock = norm(prev[1]);
      const prevVars = lines(prev[2]);
      const sameVars =
        variants.length > 0 &&
        variants.length === prevVars.length &&
        variants.every((v, i) => v === prevVars[i]);
      const continuation = variants.length === 0 && (!block || block === prevBlock);
      if (sameVars || continuation) {
        groups[groups.length - 1].push(cells);
        continue;
      }
    }
    groups.push([cells]);
  }
  return groups;
}

// ── Чтение таблиц ──────────────────────────────────────────────────────────

/** Отбор строк таблицы, общий для docx и электронных таблиц (_rows_from_file). */
function keepRow(cells: string[], rows: string[][]): void {
  const padded = [...cells];
  while (padded.length < 7) padded.push('');
  if (norm(padded[1]).toLowerCase().includes('блок вопросов')) return; // заголовок
  if (!padded.some((c) => norm(c))) return;
  rows.push(padded.slice(0, 7));
}

/** Строки всех таблиц .docx (объединённые ячейки повторяют текст — см. _docx). */
function rowsFromDocx(data: Buffer): string[][] {
  const body = loadDocxBody(data);
  const rows: string[][] = [];
  for (const table of bodyTables(body)) {
    for (const cells of tableRows(table)) keepRow(cells, rows);
  }
  return rows;
}

/** `str(cell)` как в openpyxl: даты — «YYYY-MM-DD HH:MM:SS», bool — True/False. */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const two = (n: number) => String(n).padStart(2, '0');
    return (
      `${v.getFullYear()}-${two(v.getMonth() + 1)}-${two(v.getDate())} ` +
      `${two(v.getHours())}:${two(v.getMinutes())}:${two(v.getSeconds())}`
    );
  }
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

/**
 * Строки всех листов книги. Объединённые ячейки Excel заполняются текстом
 * верхней-левой клетки — так же, как это делает python-docx для docx-таблиц,
 * иначе _group_rows не увидит продолжение группы.
 */
function rowsFromSheet(data: Buffer): string[][] {
  const wb = XLSX.read(data, { type: 'buffer', cellDates: true });
  const rows: string[][] = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    const grid = raw.map((r) => (Array.isArray(r) ? r.map(cellToString) : []));

    for (const m of ws['!merges'] || []) {
      const value = grid[m.s.r]?.[m.s.c] ?? '';
      for (let r = m.s.r; r <= m.e.r; r += 1) {
        if (!grid[r]) grid[r] = [];
        for (let c = m.s.c; c <= m.e.c; c += 1) grid[r][c] = value;
      }
    }
    for (const cells of grid) keepRow(cells, rows);
  }
  return rows;
}

// ── Импорт (порт import_faq_files) ─────────────────────────────────────────

interface EntryRow {
  group_key: string;
  position: number;
  source_file: string;
  block: string;
  variants: string[] | null;
  clarify_question: string | null;
  option_label: string | null;
  answer: string;
  doc_refs: string[] | null;
  contact: string | null;
}

interface ParsedFaqFile {
  name: string;
  rows: string[][];
}

/** Ветка-опция, которой после разбора всех файлов нужен навигационный ответ. */
interface PendingNav {
  entry: EntryRow;
  parentBlock: string;
  optionText: string;
}

/** Подпись кнопки-ветки: «(Аттестация АУП и УВП)» из скобок либо строка без
 *  нумерации «2.1 …» с заглавной буквы. */
function optionLabel(line: string): string {
  const paren = /\(([^)]{6,})\)\s*$/.exec(line);
  if (paren) return norm(paren[1]);
  const plain = norm(line.replace(/^\d+(?:\.\d+)*\s*/, ''));
  return plain ? plain[0].toUpperCase() + plain.slice(1) : line;
}

function buildEntries(files: ParsedFaqFile[]): { entries: EntryRow[]; groups: number } {
  const entries: EntryRow[] = [];
  const pendingNav: PendingNav[] = [];
  let totalGroups = 0;

  for (const file of files) {
    const groups = groupRows(file.rows);

    groups.forEach((g, gi) => {
      const block = g.map((r) => norm(r[1])).find((b) => b) ?? '';
      let variants = g.map((r) => lines(r[2])).find((v) => v.length) ?? [];
      const contactRow = g.find((r) => norm(r[6]));
      const contact = contactRow ? contactFromCell(contactRow[6]) : null;
      const keySrc = `${file.name}:${gi}:${block}`;
      const groupKey = crypto.createHash('md5').update(keySrc, 'utf8').digest('hex').slice(0, 16);

      if (g.length === 1) {
        const clar = lines(g[0][3]);
        const answer = lines(g[0][4]).join('\n');
        const refs = refLines(g[0][5]);

        // Голова-развилка целиком в одной строке: в колонке уточнения — вопрос
        // и список веток («Аттестация какой категории работников интересует» +
        // 4 категории). Раньше такая строка теряла и вопрос, и ветки — кнопка
        // меню и диалог отвечали пустотой.
        if (!variants.length && !answer && clar.length >= 3 && looksLikeQuestion(clar[0])) {
          entries.push({
            group_key: groupKey, position: 0, source_file: file.name,
            block, variants: block ? [block] : [], clarify_question: clar[0],
            option_label: null, answer: '', doc_refs: null, contact,
          });
          clar.slice(1).forEach((line, idx) => {
            const sub: EntryRow = {
              group_key: groupKey, position: idx + 1, source_file: file.name,
              block, variants: null, clarify_question: null,
              option_label: optionLabel(line), answer: '',
              doc_refs: refs.length ? refs : null, contact,
            };
            entries.push(sub);
            pendingNav.push({ entry: sub, parentBlock: block, optionText: line });
          });
          totalGroups += 1;
          return;
        }

        // Одиночная строка без вариантов, но со списком ключевых слов в колонке
        // уточнения («Социальная программа»: Льготы/Ипотека/ДМС…) — это варианты
        // запросов, попавшие не в ту колонку.
        if (!variants.length && clar.length && !looksLikeQuestion(clar[0])) variants = clar;
        if (block && !variants.includes(block)) variants = [block, ...variants];
        entries.push({
          group_key: groupKey, position: 0, source_file: file.name,
          block, variants, clarify_question: null,
          option_label: null, answer,
          doc_refs: refs.length ? refs : null, contact,
        });
      } else {
        // Ветвящаяся группа. Строка-заголовок — та, чья колонка уточнения похожа
        // на вопрос: её ответ — общее вступление.
        if (block && !variants.includes(block)) variants = [block, ...variants];
        const headIdx = g.findIndex((r) => {
          const l = lines(r[3]);
          return l.length > 0 && looksLikeQuestion(l[0]);
        });
        let clarifyQ: string | null = null;
        let intro = '';
        const subs = g.map((_, i) => i);
        if (headIdx >= 0) {
          clarifyQ = lines(g[headIdx][3])[0];
          intro = lines(g[headIdx][4]).join('\n');
          subs.splice(subs.indexOf(headIdx), 1);
        }
        entries.push({
          group_key: groupKey, position: 0, source_file: file.name,
          block, variants, clarify_question: clarifyQ,
          option_label: null, answer: intro,
          doc_refs: null, contact,
        });
        subs.forEach((i, idx) => {
          const pos = idx + 1;
          const labelLines = lines(g[i][3]);
          const label = labelLines.length ? labelLines.join(' / ') : `Вариант ${pos}`;
          const refs = refLines(g[i][5]);
          const own = contactFromCell(g[i][6]);
          entries.push({
            group_key: groupKey, position: pos, source_file: file.name,
            block, variants: null, clarify_question: null,
            option_label: label, answer: lines(g[i][4]).join('\n'),
            doc_refs: refs.length ? refs : null,
            contact: own || contact,
          });
        });
      }
      totalGroups += 1;
    });
  }

  fillNavigationAnswers(entries, pendingNav);
  return { entries, groups: totalGroups };
}

// ── Навигационные ответы веток-развилок ────────────────────────────────────
// Ветки головы «Аттестация работников» ведут к темам «Аттестация работников -
// Аттестация АУП и УВП» и т.п. — это отдельные группы (нередко в другом файле).
// Ответ ветки — список частых вопросов её темы: и кнопка меню, и диалог
// получают осмысленный ответ вместо пустоты, ничего не выдумывая от себя.

/** Слова длиной 3+ для сопоставления ветки с темой (без морфологии — темы
 *  дословно повторяют текст опций; 3 буквы нужны аббревиатурам «АУП», «УВП»). */
function navWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[а-яёa-z0-9]{3,}/gi) ?? []).map((w) => w.toLowerCase()));
}

/** Первый содержательный вариант группы — как в меню /api/chat/faq-menu. */
function firstQuestion(e: EntryRow): string | null {
  const meaningful = (e.variants ?? []).filter(
    (v) => v.trim().length > 3 && v.toLowerCase() !== e.block.toLowerCase()
  );
  return meaningful.find((v) => v.trimEnd().endsWith('?')) || meaningful[0] || null;
}

function fillNavigationAnswers(entries: EntryRow[], pending: PendingNav[]): void {
  if (!pending.length) return;
  const heads = entries.filter((e) => e.position === 0);

  for (const nav of pending) {
    const prefix = `${nav.parentBlock} - `;
    const children = heads.filter((e) => e.block.startsWith(prefix));

    // Тема (суффикс блока) с наибольшим пересечением слов с текстом опции.
    const bySuffix = new Map<string, EntryRow[]>();
    for (const c of children) {
      const sfx = c.block.slice(prefix.length);
      const list = bySuffix.get(sfx);
      if (list) list.push(c);
      else bySuffix.set(sfx, [c]);
    }
    const opt = navWords(nav.optionText);
    let bestSfx: string | null = null;
    let bestOverlap = 1; // требуем ≥2 общих слов
    for (const sfx of bySuffix.keys()) {
      let overlap = 0;
      for (const w of navWords(sfx)) if (opt.has(w)) overlap += 1;
      if (overlap > bestOverlap) {
        bestSfx = sfx;
        bestOverlap = overlap;
      }
    }

    const label = nav.entry.option_label || nav.optionText;
    if (!bestSfx) {
      nav.entry.answer =
        `Задайте вопрос по теме «${label}» своими словами — ` +
        'или выберите его в меню «Частые вопросы».';
      continue;
    }
    const questions = (bySuffix.get(bestSfx) ?? [])
      .map(firstQuestion)
      .filter((q): q is string => Boolean(q))
      .slice(0, 6);
    nav.entry.answer = questions.length
      ? `${bestSfx}. Частые вопросы по этой теме:\n` +
        questions.map((q) => `— ${q}`).join('\n') +
        '\n\nЗадайте свой вопрос своими словами — или выберите его в меню «Частые вопросы».'
      : `Задайте вопрос по теме «${bestSfx}» своими словами — или выберите его в меню «Частые вопросы».`;
  }
}

// ── Эндпоинт ───────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  // Тело читаем в буфер: если среди файлов есть .doc, тот же байт-в-байт запрос
  // уходит в FastAPI, а второй раз прочитать поток нельзя.
  const raw = await request.arrayBuffer();
  let form: FormData;
  try {
    form = await new Response(raw, {
      headers: { 'content-type': request.headers.get('content-type') || '' },
    }).formData();
  } catch {
    return validationError(['body', 'files'], 'missing', 'Field required', null);
  }

  const uploaded = form.getAll('files').filter((f): f is File => f instanceof File);
  if (!uploaded.length) {
    return validationError(['body', 'files'], 'missing', 'Field required', null);
  }

  // Проверки идут в том же порядке, что и в Python: формат, затем размер.
  const parsed: { name: string; ext: string; data: Buffer }[] = [];
  for (const f of uploaded) {
    const ext = suffixOf(f.name || '').toLowerCase();
    if (!PY_EXTS.has(ext) && !SHEET_EXTS.has(ext)) {
      return badRequest(`Неподдерживаемый формат: ${f.name}`);
    }
    if (f.size > MAX_FILE_BYTES) return badRequest(`Файл больше 20 МБ: ${f.name}`);
    parsed.push({ name: baseName(f.name || '') || 'faq.docx', ext, data: Buffer.from(await f.arrayBuffer()) });
  }

  const files: ParsedFaqFile[] = [];
  for (const f of parsed) {
    try {
      // .doc — не zip-контейнер, читаем его после конвертации LibreOffice.
      // Временный файл нужен, потому что конвертер работает с путями.
      let data = f.data;
      let ext = f.ext;
      if (ext === '.doc') {
        const tmp = path.join(tmpdir(), `faq_${randomUUID()}.doc`);
        try {
          await writeFile(tmp, f.data);
          data = await readFile(await convertToModern(tmp));
          ext = '.docx';
        } finally {
          await unlink(tmp).catch(() => undefined);
        }
      }
      files.push({
        name: f.name,
        rows: SHEET_EXTS.has(ext) ? rowsFromSheet(data) : rowsFromDocx(data),
      });
    } catch {
      /* «[FAQ] не удалось разобрать {file}» — пропускаем файл, импорт продолжается */
    }
  }

  try {
    const { entries, groups } = buildEntries(files);
    // Полный реимпорт: старые записи и новые — одной транзакцией, чтобы FAQ
    // не оказался пустым при сбое на середине.
    await prisma.$transaction([
      prisma.faq_entries.deleteMany({}),
      prisma.faq_entries.createMany({
        data: entries.map((e) => ({
          ...e,
          variants: e.variants ?? Prisma.DbNull,
          doc_refs: e.doc_refs ?? Prisma.DbNull,
          // Значение по умолчанию из модели SQLAlchemy (в схеме Prisma его нет).
          is_active: true,
        })),
      }),
    ]);
    invalidateFaqMatcher(); // прототипы пересчитаются при следующем запросе
    return NextResponse.json({ success: true, groups, entries: entries.length });
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e);
    return NextResponse.json({ detail: `Не удалось импортировать FAQ: ${detail}` }, { status: 500 });
  }
}

/**
 * PATCH/DELETE по этому пути у FastAPI обслуживает маршрут /faq/{entry_id}:
 * «import» не разбирается как int, и ответом будет 422. Экспорты нужны, чтобы
 * статический сегмент не отдал вместо этого пустой 405 самого Next.
 */
async function notAnEntryId() {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;
  return validationError(
    ['path', 'entry_id'],
    'int_parsing',
    'Input should be a valid integer, unable to parse string as an integer',
    'import'
  );
}

export const PATCH = notAnEntryId;
export const DELETE = notAnEntryId;
