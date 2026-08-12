import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildXlsx, type CellStyle, type XlsxCell } from './xlsx';
import { DocValueError, cellToString, mostCommon, ru, saveGenerated, timestamp } from './common';
import { toDocsPath } from '@/lib/news';

/**
 * Б4: опись личных дел уволенных из отчёта 1С:ЗиК «Принято уволено».
 * Порт services/documents/dismissed_inventory.py. Без LLM.
 *
 * Правила брифа УРП: в опись попадают только уволенные БЕЗ повторного приёма;
 * дата увольнения = «дата записи» − 1 день; по умолчанию — категории
 * административного блока (АУП/АХП/УВП).
 *
 * Отличия от Python-порта (исправления по отзыву УРП от 21.07):
 * — приём/увольнение сопоставляются по человеку (ФИО без «(вн. совм.)»);
 * — один человек — одна строка описи, должности перечисляются списком.
 */

/** Триггер чат-команды «опись личных дел уволенных». */
export const INVENTORY_REQUEST_RE = ru(
  'опис\\w*\\s+(?:личн\\w+\\s+дел|увол)|уволенн\\w+\\s+в\\s+архив',
  'i'
);

const ADMIN_CATEGORIES = new Set(['АУП', 'АУПН', 'АХП', 'АХПН', 'УВП']);
const DT_RE = /(\d{2})\.(\d{2})\.(\d{4})/;
const DAY_MS = 86_400_000;

// «Иванов Иван Иванович (вн. совм.)» → ключ человека без суффикса занятости.
// После скобок остаётся пунктуация («(осн).» — точка снаружи), поэтому ключ —
// только буквы, дефисы и пробелы.
const FIO_PAREN_RE = /\s*\([^)]*\)/g;
function normFio(fio: string): string {
  return fio
    .replace(FIO_PAREN_RE, ' ')
    .replace(/[^\p{L}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface InventoryItem {
  n: number;
  fio: string;
  position: string;
  unit: string;
  dismissed_at: string;
}

export interface InventoryResult {
  year: number;
  total_records: number;
  fired_total: number;
  skipped_rehired: number;
  items: InventoryItem[];
}

/** Дата ячейки как UTC-полночь (Date из SheetJS либо «дд.мм.гггг» в тексте). */
function cellDate(v: unknown): number | null {
  if (v instanceof Date) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
  const m = DT_RE.exec(cellToString(v));
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? ts : null;
}

function ddmmyyyy(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

interface DismissRecord {
  fio: string;
  unit: string;
  position: string;
  category: string;
  rate: string;
  event: string;
  record_date: number | null;
}

/** Разбирает отчёт «Принято уволено» и строит список для описи. */
export function analyzeDismissedRows(rows: unknown[][], allCategories = false): InventoryResult {
  let headerRow: number | null = null;
  const col: Record<string, number> = {};

  for (let ri = 0; ri < Math.min(rows.length, 15); ri += 1) {
    const cells = rows[ri].map((v) => (v === null || v === undefined ? '' : cellToString(v).trim().toLowerCase()));
    if (!cells.some((c) => c.includes('сотрудник')) || !cells.some((c) => c.includes('вид события'))) {
      continue;
    }
    headerRow = ri;
    cells.forEach((c, ci) => {
      if (c.includes('дата записи')) col.record_date = ci;
      else if (c === 'сотрудник') col.fio = ci;
      else if (c.includes('иерарх')) col.unit = ci;
      else if (c === 'должность') col.position = ci;
      else if (c.includes('категория')) col.category = ci;
      else if (c.includes('количество ставок')) col.rate = ci;
      else if (c.includes('вид события')) col.event = ci;
    });
    break;
  }
  if (headerRow === null || col.fio === undefined || col.event === undefined) {
    throw new DocValueError('Файл не похож на отчёт «Принято уволено» из 1С:ЗиК');
  }

  const get = (row: unknown[], key: string): unknown => {
    const i = col[key];
    const v = i !== undefined && i < row.length ? row[i] : null;
    return v === null || v === undefined ? '' : v;
  };

  const records: DismissRecord[] = [];
  for (const row of rows.slice(headerRow + 1)) {
    const event = cellToString(get(row, 'event')).trim().toLowerCase();
    if (!event) continue;
    records.push({
      fio: cellToString(get(row, 'fio')).trim(),
      unit: cellToString(get(row, 'unit')).trim(),
      position: cellToString(get(row, 'position')).trim(),
      category: cellToString(get(row, 'category')).trim().toUpperCase(),
      rate: cellToString(get(row, 'rate')).trim(),
      event: event.includes('прием') || event.includes('приём')
        ? 'hire'
        : event.includes('увольнение')
          ? 'fire'
          : event,
      record_date: cellDate(get(row, 'record_date')),
    });
  }
  if (!records.length) {
    throw new DocValueError('В отчёте не нашлось строк с событиями «Прием»/«Увольнение»');
  }

  // Повторный приём: у сотрудника есть «Прием» с датой ПОЗЖЕ увольнения
  // (или без даты — консервативно тоже считаем повторным приёмом).
  //
  // ФИО в выгрузке 1С идёт с суффиксом занятости — «(вн. совм.)», «(осн.)» и
  // ещё полдюжины написаний. Сопоставлять приём с увольнением нужно ПО ЧЕЛОВЕКУ,
  // иначе уволенный «Иванов (совм.)» не найдёт свой приём «Иванов (осн.)» и
  // ошибочно попадёт в опись (на реальном отчёте — 9 лишних человек).
  const byFio = new Map<string, DismissRecord[]>();
  for (const r of records) {
    if (!r.fio) continue;
    const key = normFio(r.fio);
    const list = byFio.get(key);
    if (list) list.push(r);
    else byFio.set(key, [r]);
  }

  const sortable: (InventoryItem & { _fio: string; _date: number })[] = [];
  let skippedRehired = 0;
  for (const r of records) {
    if (r.event !== 'fire') continue;
    const rehired = (byFio.get(normFio(r.fio)) ?? []).some(
      (other) =>
        other.event === 'hire' &&
        (other.record_date === null || r.record_date === null || other.record_date >= r.record_date)
    );
    if (rehired) {
      skippedRehired += 1;
      continue;
    }
    if (!allCategories && r.category && !ADMIN_CATEGORIES.has(r.category)) continue;
    const dismiss = r.record_date === null ? null : r.record_date - DAY_MS;
    let pos = r.position;
    if (r.rate) pos = pos ? `${pos} (${r.rate} ст.)` : `(${r.rate} ст.)`;
    sortable.push({
      n: 0,
      fio: r.fio || '—',
      position: pos,
      unit: r.unit,
      dismissed_at: dismiss === null ? '' : ddmmyyyy(dismiss),
      _fio: normFio(r.fio) || '—',
      // date.min в Python — минимальная возможная дата, сортирует записи без даты вперёд.
      _date: dismiss ?? Number.NEGATIVE_INFINITY,
    });
  }

  // Личное дело одно на человека, а записей об увольнении — по числу ставок
  // (совместительства). Схлопываем строки одного человека: дата — самая
  // поздняя, должности — списком, ФИО — вариант без суффикса занятости,
  // если он есть (у HR в образце три строки «Аминова…» на одно дело).
  const byPerson = new Map<string, typeof sortable>();
  for (const it of sortable) {
    const list = byPerson.get(it._fio);
    if (list) list.push(it);
    else byPerson.set(it._fio, [it]);
  }
  const collapsed: typeof sortable = [];
  for (const group of byPerson.values()) {
    const base = group.reduce((a, b) => (b._date > a._date ? b : a));
    const fio = group.find((g) => !g.fio.includes('('))?.fio ?? base.fio;
    const positions = [...new Set(group.map((g) => g.position).filter(Boolean))];
    collapsed.push({
      ...base,
      fio,
      position: positions.join('; '),
    });
  }

  collapsed.sort((a, b) => (a._fio < b._fio ? -1 : a._fio > b._fio ? 1 : a._date - b._date));
  const items: InventoryItem[] = collapsed.map((it, i) => ({
    n: i + 1,
    fio: it.fio,
    position: it.position,
    unit: it.unit,
    dismissed_at: it.dismissed_at,
  }));

  const years = records
    .filter((r) => r.record_date !== null)
    .map((r) => new Date(r.record_date as number).getUTCFullYear());
  const year = mostCommon(years) ?? new Date().getFullYear();

  return {
    year,
    total_records: records.length,
    fired_total: records.filter((r) => r.event === 'fire').length,
    skipped_rehired: skippedRehired,
    items,
  };
}

// ── число прописью ─────────────────────────────────────────────────────────

const UNITS = ['', 'одно', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

/** 0–999 прописью (для «157 (сто пятьдесят семь) личных дел»). */
export function numWords(n: number): string {
  if (n === 0) return 'ноль';
  const parts = [HUNDREDS[Math.floor(n / 100)]];
  const rem = n % 100;
  if (rem >= 10 && rem <= 19) parts.push(TEENS[rem - 10]);
  else {
    parts.push(TENS[Math.floor(rem / 10)]);
    parts.push(UNITS[rem % 10]);
  }
  return parts.filter((p) => p).join(' ');
}

// ── xlsx-опись по образцу УРП ──────────────────────────────────────────────

const CENTER: CellStyle = { align: 'center', vAlign: 'center', wrap: true };
const LEFT: CellStyle = { align: 'left', vAlign: 'top', wrap: true };

/** xlsx-опись по образцу УРП (шапка, УТВЕРЖДАЮ, таблица, подписи). */
export function buildInventoryXlsx(result: InventoryResult): Buffer {
  const cells: XlsxCell[] = [];
  const merges: { r1: number; c1: number; r2: number; c2: number }[] = [];

  const merged = (row: number, text: string, bold = false, size = 11) => {
    merges.push({ r1: row, c1: 1, r2: row, c2: 5 });
    cells.push({ row, col: 1, value: text, style: { ...CENTER, bold, size } });
  };

  merged(1, 'МИНИСТЕРСТВО НАУКИ И ВЫСШЕГО ОБРАЗОВАНИЯ РОССИЙСКОЙ ФЕДЕРАЦИИ', false, 10);
  merged(2, 'ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ ОБРАЗОВАТЕЛЬНОЕ УЧРЕЖДЕНИЕ ВЫСШЕГО ОБРАЗОВАНИЯ', false, 10);
  merged(3, '«ТЮМЕНСКИЙ ИНДУСТРИАЛЬНЫЙ УНИВЕРСИТЕТ»', true, 11);
  merged(4, 'УПРАВЛЕНИЕ ПО РАБОТЕ С ПЕРСОНАЛОМ', false, 10);
  cells.push({ row: 6, col: 4, value: 'УТВЕРЖДАЮ', style: { bold: true } });
  cells.push({ row: 7, col: 4, value: 'Начальник УРП' });
  cells.push({ row: 8, col: 4, value: '____________ Н. Г. Дударева' });
  cells.push({ row: 9, col: 4, value: '«____» __________ 20___ г.' });
  merged(
    11,
    'ОПИСЬ\nличных дел административно-управленческого, административно-хозяйственного ' +
      `и учебно-вспомогательного персонала ТИУ, уволенных в ${result.year} году`,
    true
  );

  const hdrRow = 13;
  ['№ п/п', 'Ф.И.О.', 'Должность', 'Структурное подразделение', 'Дата увольнения'].forEach((h, i) => {
    cells.push({ row: hdrRow, col: i + 1, value: h, style: { ...CENTER, bold: true, border: true } });
  });
  for (const it of result.items) {
    const r = hdrRow + it.n;
    const values: (string | number)[] = [it.n, it.fio, it.position, it.unit, it.dismissed_at];
    values.forEach((v, i) => {
      const ci = i + 1;
      cells.push({ row: r, col: ci, value: v, style: { ...(ci >= 2 && ci <= 4 ? LEFT : CENTER), border: true } });
    });
  }

  const n = result.items.length;
  const foot = hdrRow + n + 2;
  cells.push({ row: foot, col: 1, value: `Передала ${n} (${numWords(n)}) личных дел` });
  cells.push({ row: foot + 1, col: 1, value: 'Начальник УРП' });
  cells.push({ row: foot + 1, col: 4, value: 'Н. Г. Дударева' });
  cells.push({ row: foot + 3, col: 1, value: `Приняла ${n} (${numWords(n)}) личных дел` });
  cells.push({ row: foot + 4, col: 1, value: 'Руководитель архивной службы общего отдела' });
  cells.push({ row: foot + 4, col: 4, value: 'О. И. Вологодская' });

  return buildXlsx([
    {
      name: 'Опись',
      cells,
      merges,
      rows: [{ row: 11, height: 48 }],
      cols: [
        { col: 1, width: 7 }, { col: 2, width: 32 }, { col: 3, width: 34 },
        { col: 4, width: 40 }, { col: 5, width: 15 },
      ],
    },
  ]);
}

export async function createInventory(userId: number, rows: unknown[][], allCategories: boolean) {
  const result = analyzeDismissedRows(rows, allCategories);
  const filePath = await saveGenerated(
    `inventory_${result.year}_${timestamp()}.xlsx`,
    buildInventoryXlsx(result)
  );
  const rec = await prisma.my_documents.create({
    data: {
      user_id: userId,
      title: `Опись личных дел уволенных в ${result.year} году (${result.items.length} чел.)`,
      template_key: 'dismissed_inventory',
      file_path: toDocsPath(filePath),
      progress: 100,
      status: 'ready',
      fields: { year: result.year, count: result.items.length } as Prisma.InputJsonValue,
      is_pii: true, // ФИО уволенных работников — документ не хранится
    },
  });
  return { rec, result };
}
