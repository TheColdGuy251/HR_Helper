import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildXlsx, type XlsxCell } from './xlsx';
import { crc32, sequenceRatio } from './seqmatch';
import { DocValueError, round1, saveGenerated, timestamp } from './common';
import { toDocsPath } from '@/lib/news';

/**
 * Б7: поиск однотипных инструкций по охране труда.
 * Порт services/documents/ot_dedup.py. Без LLM.
 *
 * 1) дешёвый кандидат-отбор: шинглы (5-словные n-граммы, crc32) + инвертированный
 *    индекс → Dice-коэффициент по множествам шинглов для всех пар сразу;
 * 2) точная похожесть для кандидатов: SequenceMatcher по СЛОВАМ.
 */

/**
 * Триггер чат-команды «найди дубликаты инструкций».
 * `[\w-]` из Python пишем классом целиком: ru() подставляет \w как готовый
 * класс, и вложить его внутрь другого класса нельзя.
 */
export const OT_DEDUP_REQUEST_RE =
  /(?:дубл|однотип|совпаден)[0-9A-Za-zА-Яа-яЁё_-]*[^.]{0,60}инструкц|инструкц[0-9A-Za-zА-Яа-яЁё_-]*[^.]{0,60}(?:дубл|однотип)/i;

const WORD_RE = /[а-яёa-z0-9]+/gi;
const SHINGLE = 5;
const CANDIDATE_DICE = 0.5;
/** Порог «однотипные» из брифа отдела ОТ. */
export const DUPLICATE_THRESHOLD = 0.8;
/** Пары ниже порога, но выше этого — «пограничные», тоже попадают в отчёт. */
const REPORT_THRESHOLD = 0.6;

function words(text: string): string[] {
  return (text || '').toLowerCase().match(WORD_RE) ?? [];
}

function shingles(ws: string[]): Set<number> {
  const enc = new TextEncoder();
  if (ws.length < SHINGLE) {
    return ws.length ? new Set([crc32(enc.encode(ws.join(' ')))]) : new Set();
  }
  const out = new Set<number>();
  for (let i = 0; i <= ws.length - SHINGLE; i += 1) {
    out.add(crc32(enc.encode(ws.slice(i, i + SHINGLE).join(' '))));
  }
  return out;
}

export interface DedupPair {
  a: string;
  b: string;
  percent: number;
}
export interface DedupGroup {
  files: string[];
  size: number;
  min_percent: number;
  max_percent: number;
}
export interface DedupResult {
  files: number;
  pairs: DedupPair[];
  duplicates: number;
  groups: DedupGroup[];
  unreadable: string[];
}

/** docs: [имя файла, текст] → пары и группы однотипных. */
export function compareDocuments(docs: [string, string][]): Omit<DedupResult, 'unreadable'> {
  const names = docs.map(([n]) => n);
  const wordLists = docs.map(([, t]) => words(t));
  const shingleSets = wordLists.map(shingles);

  // Инвертированный индекс шинглов → счётчик общих шинглов по парам
  const byShingle = new Map<number, number[]>();
  shingleSets.forEach((ss, i) => {
    for (const h of ss) {
      const list = byShingle.get(h);
      if (list) list.push(i);
      else byShingle.set(h, [i]);
    }
  });
  const common = new Map<string, number>();
  for (const ids of byShingle.values()) {
    // Шингл-«шум», общий для всех файлов, не информативен.
    if (ids.length < 2 || ids.length > 50) continue;
    for (let x = 0; x < ids.length; x += 1) {
      for (let y = x + 1; y < ids.length; y += 1) {
        const key = `${ids[x]},${ids[y]}`;
        common.set(key, (common.get(key) ?? 0) + 1);
      }
    }
  }

  const candidates: [number, number][] = [];
  for (const [key, c] of common) {
    const [i, j] = key.split(',').map(Number);
    const denom = shingleSets[i].size + shingleSets[j].size;
    if (denom && (2 * c) / denom >= CANDIDATE_DICE) candidates.push([i, j]);
  }

  const pairs: (DedupPair & { _i: number; _j: number })[] = [];
  for (const [i, j] of candidates) {
    const ratio = sequenceRatio(wordLists[i], wordLists[j]);
    if (ratio >= REPORT_THRESHOLD) {
      pairs.push({ a: names[i], b: names[j], percent: round1(ratio * 100), _i: i, _j: j });
    }
  }
  pairs.sort((x, y) => y.percent - x.percent);

  // Группы однотипных (связные компоненты по парам ≥ 80%)
  const parent = docs.map((_, i) => i);
  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };
  for (const p of pairs) {
    if (p.percent >= DUPLICATE_THRESHOLD * 100) {
      const a = find(p._i);
      const b = find(p._j);
      if (a !== b) parent[a] = b;
    }
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < docs.length; i += 1) {
    const root = find(i);
    const list = members.get(root);
    if (list) list.push(i);
    else members.set(root, [i]);
  }
  const groups: DedupGroup[] = [];
  for (const ids of members.values()) {
    if (ids.length < 2) continue;
    const inGroup = pairs
      .filter((p) => p.percent >= DUPLICATE_THRESHOLD * 100 && find(p._i) === find(ids[0]))
      .map((p) => p.percent);
    groups.push({
      files: ids.map((i) => names[i]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      size: ids.length,
      min_percent: inGroup.length ? Math.min(...inGroup) : 0,
      max_percent: inGroup.length ? Math.max(...inGroup) : 0,
    });
  }
  groups.sort((a, b) => b.size - a.size);

  return {
    files: docs.length,
    pairs: pairs.map(({ a, b, percent }) => ({ a, b, percent })),
    duplicates: pairs.filter((p) => p.percent >= DUPLICATE_THRESHOLD * 100).length,
    groups,
  };
}

/** «{v:.0f}» из Python: половина округляется к чётному. */
function fmt0(v: number): string {
  const fl = Math.floor(v);
  const diff = v - fl;
  const r = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1;
  return String(r);
}

/** xlsx-отчёт: лист «Пары» (все ≥60%) + лист «Группы однотипных» (≥80%). */
export function buildDedupXlsx(result: Omit<DedupResult, 'unreadable'>): Buffer {
  const pairCells: XlsxCell[] = [];
  ['Инструкция 1', 'Инструкция 2', 'Совпадение, %'].forEach((h, i) => {
    pairCells.push({ row: 1, col: i + 1, value: h, style: { bold: true } });
  });
  result.pairs.forEach((p, idx) => {
    const row = idx + 2;
    const fill = p.percent >= DUPLICATE_THRESHOLD * 100 ? 'FDE8E8' : undefined;
    pairCells.push({ row, col: 1, value: p.a, style: fill ? { fill } : undefined });
    pairCells.push({ row, col: 2, value: p.b, style: fill ? { fill } : undefined });
    pairCells.push({ row, col: 3, value: p.percent, style: fill ? { fill } : undefined });
  });

  const groupCells: XlsxCell[] = [];
  ['Группа', 'Файлов', 'Совпадение, %', 'Файлы (кандидаты на объединение)'].forEach((h, i) => {
    groupCells.push({ row: 1, col: i + 1, value: h, style: { bold: true } });
  });
  result.groups.forEach((g, gi) => {
    const row = gi + 2;
    const rng =
      g.min_percent !== g.max_percent
        ? `${fmt0(g.min_percent)}–${fmt0(g.max_percent)}`
        : fmt0(g.max_percent);
    groupCells.push({ row, col: 1, value: gi + 1 });
    groupCells.push({ row, col: 2, value: g.size });
    groupCells.push({ row, col: 3, value: rng });
    groupCells.push({
      row,
      col: 4,
      value: g.files.join('\n'),
      style: { wrap: true, vAlign: 'top' },
    });
  });

  return buildXlsx([
    {
      name: 'Пары',
      cells: pairCells,
      cols: [{ col: 1, width: 60 }, { col: 2, width: 60 }, { col: 3, width: 16 }],
    },
    { name: 'Группы однотипных', cells: groupCells, cols: [{ col: 4, width: 90 }] },
  ]);
}

/** Полный цикл: разобранные инструкции → сравнение → xlsx в «Мои документы». */
export async function runDedup(userId: number, docs: [string, string][], unreadable: string[]) {
  if (docs.length < 2) {
    throw new DocValueError('В архиве меньше двух читаемых инструкций (docx/doc/pdf/rtf/txt)');
  }
  const result: DedupResult = { ...compareDocuments(docs), unreadable };
  const filePath = await saveGenerated(`ot_dedup_${timestamp()}.xlsx`, buildDedupXlsx(result));
  const rec = await prisma.my_documents.create({
    data: {
      user_id: userId,
      title: `Дубликаты инструкций ОТ (${result.files} файлов, ${result.duplicates} пар ≥80%)`,
      template_key: 'ot_dedup',
      file_path: toDocsPath(filePath),
      progress: 100,
      status: 'ready',
      fields: { files: result.files, duplicates: result.duplicates } as Prisma.InputJsonValue,
      is_pii: false, // значение по умолчанию модели MyDocuments
    },
  });
  return { rec, result };
}
