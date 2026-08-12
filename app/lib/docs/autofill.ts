import 'server-only';
import PizZip from 'pizzip';
import {
  child,
  childrenOf,
  element,
  innerText,
  isElement,
  parseXml,
  serializeXml,
  textNode,
  type XElement,
} from './xml';
import { pyStr } from '@/lib/kb';
import { ru } from './common';

/**
 * Заполнение бланков БЕЗ {{ переменных }} — порт
 * services/documents/autofill.py (analyze + autofill).
 *
 * Бланк «пустографка»: значения подставляются прямо в области ввода
 * (таблицы 1×1, пустые абзацы с рамкой, подчёркнутые пробелы), формат места
 * при этом сохраняется. Роль поля выводится из соседних подписей.
 *
 * Python работает через python-docx; здесь та же логика применяется к дереву
 * `word/document.xml` (см. lib/docs/xml.ts): всё, что не трогаем, остаётся в
 * файле дословно, поэтому вёрстка бланка не меняется.
 */

const CAPTION_MAX = 90;

// role_key → [базовое имя поля, подпись, обязательность]
const ROLES: Record<string, [string, string, boolean]> = {
  head: ['head', 'ФИО и должность руководителя', true],
  head_fio: ['head_fio', 'ФИО руководителя', true],
  head_position: ['head_position', 'Должность руководителя', false],
  employee_fio: ['employee_fio', 'ФИО работника', true],
  employee_position: ['employee_position', 'Должность работника', false],
  department: ['department', 'Подразделение', true],
  reason: ['reason', 'Причина / основание', true],
  field: ['field', 'Поле', false],
};

const CAPTION_HINT_RE = ru(
  'ф\\.?и\\.?о|должност|подпис|подразделен|наименован|причин|руководител|работник',
  'i'
);
// «Кому» — только отдельным словом, иначе сюда попадали бы «кому-то» и т.п.
const HEAD_CAP_RE = ru('\\bкому\\b|руководител|ректор|директор|проректор');

/** str.islower() для первого символа строки. */
function firstIsLower(t: string): boolean {
  const c = t.slice(0, 1);
  if (!c) return false;
  return c.toLowerCase() === c && c.toUpperCase() !== c;
}

function looksLikeCaption(raw: string): boolean {
  const t = (raw || '').trim();
  if (!t) return false;
  if (t.startsWith('(')) return true;
  if (t.length > CAPTION_MAX) return false;
  return firstIsLower(t) || CAPTION_HINT_RE.test(t);
}

/** Сущность подписи для СМЕЖНОСТИ (шапка ФИО/должность). */
function captionEntity(text: string): string | null {
  const low = (text || '').toLowerCase();
  if (low.includes('подпис')) return null;
  if (/руководител|ректор|директор|проректор/.test(low)) return 'head';
  if (/работник|сотрудник/.test(low)) return 'employee';
  if (/подразделен|наименован/.test(low)) return 'department';
  return null;
}

/** Роль для поля, у которого подпись/контекст рядом. */
function captionRole(caption: string, prec = ''): string | null {
  const cap = `${prec} ${caption}`.toLowerCase();
  if (/сведени|второ\w*\s+родител|подпис/.test(cap)) return null;
  const hasFio = /ф\.?\s*и\.?\s*о|фамили/.test(cap);
  const hasPos = cap.includes('должност');
  if (HEAD_CAP_RE.test(cap)) return 'head';
  if (/работник|сотрудник/.test(cap)) return hasFio || !hasPos ? 'employee_fio' : 'employee_position';
  if (/подразделен/.test(cap) || /наименован/.test(cap)) return 'department';
  if (/причин|основани|уволить/.test(cap)) return 'reason';
  if (hasPos) return 'employee_position';
  if (hasFio) return 'employee_fio';
  return null;
}

// ── чтение документа ───────────────────────────────────────────────────────

const RUN_CONTENT = new Set(['w:t', 'w:tab', 'w:br', 'w:cr']);

/** Текст прогона: python-docx превращает w:tab в \t, w:br/w:cr — в \n. */
function runText(r: XElement): string {
  let out = '';
  for (const c of r.children) {
    if (!isElement(c)) continue;
    if (c.tag === 'w:t') out += innerText(c);
    else if (c.tag === 'w:tab') out += '\t';
    else if (c.tag === 'w:br' || c.tag === 'w:cr') out += '\n';
  }
  return out;
}

/** Прямые прогоны абзаца — как Paragraph.runs (без содержимого гиперссылок). */
function runsOf(p: XElement): XElement[] {
  return childrenOf(p, 'w:r');
}

function paraText(p: XElement): string {
  return runsOf(p).map(runText).join('');
}

/** run.underline: истинно для любого w:u, кроме отсутствующего и val="none". */
function runUnderlined(r: XElement): boolean {
  const rPr = child(r, 'w:rPr');
  const u = rPr ? child(rPr, 'w:u') : null;
  if (!u) return false;
  const val = u.attrs['w:val'];
  return val !== undefined && val !== 'none';
}

/** Индексы прогонов, являющихся ПОДЧЁРКНУТЫМИ ПРОБЕЛАМИ (место ввода). */
function uspaceRuns(p: XElement): number[] {
  const out: number[] = [];
  runsOf(p).forEach((r, k) => {
    const txt = runText(r);
    if (!txt || txt.length < 2) return;
    if (!runUnderlined(r)) return;
    if ([...txt].every((ch) => ch === ' ' || ch === '\t' || ch === '\xa0')) out.push(k);
  });
  return out;
}

/** 1×1 таблица — область ввода (в эталонах — с нижней рамкой). */
function isFieldTable(tbl: XElement): boolean {
  const rows = childrenOf(tbl, 'w:tr');
  const grid = child(tbl, 'w:tblGrid');
  const cols = grid ? childrenOf(grid, 'w:gridCol').length : 0;
  return rows.length === 1 && cols === 1;
}

function paraHasBorder(p: XElement): boolean {
  const pPr = child(p, 'w:pPr');
  const bdr = pPr ? child(pPr, 'w:pBdr') : null;
  return Boolean(bdr && (child(bdr, 'w:top') || child(bdr, 'w:bottom')));
}

/** Пустой абзац-линия: сам с рамкой ИЛИ следующий рисует линию сверху. */
function isBorderEmptyPara(paras: XElement[], i: number): boolean {
  const p = paras[i];
  if (paraText(p).trim()) return false;
  if (paraHasBorder(p)) return true;
  return i + 1 < paras.length && paraHasBorder(paras[i + 1]);
}

// ── правка документа ───────────────────────────────────────────────────────

/** run.text = value: содержимое прогона очищается, w:rPr сохраняется. */
function setRunText(r: XElement, value: string): void {
  r.children = r.children.filter((c) => !(isElement(c) && RUN_CONTENT.has(c.tag)));
  let buf = '';
  const flushT = () => {
    if (!buf) return;
    // Пробелы по краям Word схлопывает, если не пометить их как значимые.
    const attrs: Record<string, string> =
      buf.trim().length < buf.length ? { 'xml:space': 'preserve' } : {};
    r.children.push(element('w:t', attrs, [textNode(buf)]));
    buf = '';
  };
  for (const ch of value) {
    if (ch === '\t') {
      flushT();
      r.children.push(element('w:tab'));
    } else if (ch === '\n' || ch === '\r') {
      flushT();
      r.children.push(element('w:br'));
    } else {
      buf += ch;
    }
  }
  flushT();
  r.empty = r.children.length === 0;
}

/** paragraph.add_run(text) c подчёркиванием — новый прогон в конец абзаца. */
function addUnderlinedRun(p: XElement, value: string): void {
  const r = element('w:r', {}, [element('w:rPr', {}, [element('w:u', { 'w:val': 'single' })])]);
  setRunText(r, value);
  p.children.push(r);
  p.empty = false;
}

// Порядок дочерних элементов w:pPr по схеме CT_PPr — нужен, чтобы вставить
// w:jc на его законное место (python-docx дописывает в конец, но Word к
// нарушению порядка относится хуже, чем к его соблюдению).
const PPR_ORDER = [
  'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr',
  'w:widowControl', 'w:numPr', 'w:suppressLineNumbers', 'w:pBdr', 'w:shd',
  'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap', 'w:overflowPunct',
  'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd',
  'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents',
  'w:suppressOverlap', 'w:jc', 'w:textDirection', 'w:textAlignment',
  'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle', 'w:rPr',
  'w:sectPr', 'w:pPrChange',
];

function getOrAddPPr(p: XElement): XElement {
  const found = child(p, 'w:pPr');
  if (found) return found;
  const pPr = element('w:pPr', {}, []);
  pPr.empty = false;
  p.children.unshift(pPr); // w:pPr всегда первый ребёнок w:p
  p.empty = false;
  return pPr;
}

function ensureCenterJc(p: XElement): void {
  const pPr = getOrAddPPr(p);
  if (child(pPr, 'w:jc')) return;
  const jc = element('w:jc', { 'w:val': 'center' });
  const rank = PPR_ORDER.indexOf('w:jc');
  const at = pPr.children.findIndex(
    (c) => isElement(c) && PPR_ORDER.indexOf(c.tag) > rank
  );
  if (at < 0) pPr.children.push(jc);
  else pPr.children.splice(at, 0, jc);
  pPr.empty = false;
}

/** Значение в ячейку 1×1 по центру (сохраняя рамку/стиль). */
function setCellValue(tbl: XElement, value: string): void {
  const tr = childrenOf(tbl, 'w:tr')[0];
  const tc = tr ? childrenOf(tr, 'w:tc')[0] : null;
  const para = tc ? childrenOf(tc, 'w:p')[0] : null;
  if (!para) return;

  ensureCenterJc(para);
  const runs = runsOf(para);
  for (const r of runs) setRunText(r, '');
  if (runs.length) setRunText(runs[0], value);
  else {
    const r = element('w:r', {}, []);
    setRunText(r, value);
    para.children.push(r);
    para.empty = false;
  }
}

/** Значение поверх подчёркнутого-пробельного прогона (подчёркивание остаётся). */
function fillUspace(p: XElement, runIdx: number, value: string): void {
  const run = runsOf(p)[runIdx];
  if (!run) return;
  const width = runText(run).length;
  const v = String(value).split(/\s+/).filter((x) => x).join(' ');
  if (v.length + 2 >= width) setRunText(run, ` ${v} `);
  else {
    const rem = width - v.length;
    setRunText(run, ' '.repeat(Math.floor(rem / 2)) + v + ' '.repeat(rem - Math.floor(rem / 2)));
  }
}

// ── анализ: план заполнения ────────────────────────────────────────────────

type PlanItem =
  | { kind: 'table'; tableIdx: number; field: string }
  | { kind: 'para'; paraIdx: number; field: string }
  | { kind: 'uspace'; paraIdx: number; runIdx: number; field: string };

export interface FieldSpec {
  name: string;
  label: string;
  type: string;
  required: boolean;
}

function analyzeBody(body: XElement): { schema: FieldSpec[]; plan: PlanItem[] } {
  // Таблицы адресуются номером среди ВСЕХ таблиц тела (как doc.tables),
  // поэтому здесь достаточно счётчика ниже.
  const paras = childrenOf(body, 'w:p');

  const schema = new Map<string, FieldSpec>();
  const roleCounts = new Map<string, number>();
  const fieldFor = (roleKey: string): string => {
    const [base, label, required] = ROLES[roleKey] ?? ROLES.field;
    const n = (roleCounts.get(base) ?? 0) + 1;
    roleCounts.set(base, n);
    const name = n === 1 ? base : `${base}_${n}`;
    if (!schema.has(name)) {
      schema.set(name, { name, label: n === 1 ? label : `${label} ${n}`, type: 'string', required });
    }
    return name;
  };

  const plan: PlanItem[] = [];

  // === 1) ТАБЛИЦЫ (1×1) — роли по СМЕЖНОСТИ подписи (ФИО над / должность под)
  const seq: ['tbl' | 'cap', number | string][] = [];
  let tblCounter = 0;
  for (const node of body.children) {
    if (!isElement(node)) continue;
    if (node.tag === 'w:tbl') {
      if (isFieldTable(node)) seq.push(['tbl', tblCounter]);
      tblCounter += 1;
    } else if (node.tag === 'w:p') {
      const ts = paraText(node).trim();
      if (looksLikeCaption(ts)) {
        const ent = captionEntity(ts);
        if (ent) seq.push(['cap', ent]);
      }
    }
  }

  const tblRole = new Map<number, string>();
  seq.forEach(([kind, value], ci) => {
    if (kind !== 'cap') return;
    const ent = value as string;
    const above = ci - 1 >= 0 && seq[ci - 1][0] === 'tbl' ? (seq[ci - 1][1] as number) : null;
    const below = ci + 1 < seq.length && seq[ci + 1][0] === 'tbl' ? (seq[ci + 1][1] as number) : null;
    const assign = (idx: number | null, role: string) => {
      if (idx !== null && !tblRole.has(idx)) tblRole.set(idx, role);
    };
    if (ent === 'head' || ent === 'employee') {
      assign(above, `${ent}_fio`);
      assign(below, `${ent}_position`);
    } else {
      assign(above, 'department');
      assign(below, 'department');
    }
  });

  for (const [kind, value] of seq) {
    if (kind !== 'tbl') continue;
    const tidx = value as number;
    const role = tblRole.get(tidx);
    if (role) plan.push({ kind: 'table', tableIdx: tidx, field: fieldFor(role) });
  }

  // === 2) ВЫДЕЛЕННЫЕ ПУСТЫЕ АБЗАЦЫ (гос-формы) — по ближайшей подписи ниже.
  // Несколько пустых строк под одной подписью = ОДНО поле (заполняем первую).
  const capBelow = (i: number): string => {
    for (let j = i + 1; j < Math.min(i + 12, paras.length); j += 1) {
      const t = paraText(paras[j]).trim();
      if (!t) continue;
      return looksLikeCaption(t) ? t : '';
    }
    return '';
  };
  const epara: [number, string][] = [];
  for (let i = 0; i < paras.length; i += 1) {
    if (isBorderEmptyPara(paras, i)) epara.push([i, capBelow(i)]);
  }
  let gi = 0;
  while (gi < epara.length) {
    const cap = epara[gi][1];
    const first = epara[gi][0];
    let gj = gi + 1;
    while (gj < epara.length && epara[gj][1] === cap) gj += 1;
    const role = captionRole(cap);
    if (role) plan.push({ kind: 'para', paraIdx: first, field: fieldFor(role) });
    gi = gj;
  }

  // === 3) ПОДЧЁРКНУТЫЕ ПРОБЕЛЫ — по тексту перед ними / подписи ниже
  const usedUspacePara = new Set(
    plan.filter((it) => it.kind === 'para').map((it) => (it as { paraIdx: number }).paraIdx)
  );
  for (let i = 0; i < paras.length; i += 1) {
    const p = paras[i];
    const runsIdx = uspaceRuns(p);
    if (!runsIdx.length || usedUspacePara.has(i)) continue;

    let cap = '';
    for (let j = i + 1; j < Math.min(i + 4, paras.length); j += 1) {
      const t = paraText(paras[j]).trim();
      if (!t) continue;
      cap = looksLikeCaption(t) ? t : '';
      break;
    }
    let acc = 0;
    const runs = runsOf(p);
    for (let k = 0; k < runs.length; k += 1) {
      if (k === runsIdx[0]) break;
      acc += runText(runs[k]).length;
    }
    const prec = paraText(p).slice(0, acc).split(/\s+/).filter((x) => x).slice(-6).join(' ');
    const role = captionRole(cap, prec);
    // только ПЕРВЫЙ подчёркнутый пробел абзаца заполняем значением поля
    if (role) plan.push({ kind: 'uspace', paraIdx: i, runIdx: runsIdx[0], field: fieldFor(role) });
  }

  return { schema: [...schema.values()], plan };
}

// ── публичный API ──────────────────────────────────────────────────────────

/** Тело документа `word/document.xml`. */
function bodyOf(root: XElement): XElement {
  const body = child(root, 'w:body');
  if (!body) throw new Error('В документе нет w:body');
  return body;
}

/** Авто-определённая схема полей бланка (analyze → schema). */
export function analyzeBlank(content: Buffer): FieldSpec[] {
  const zip = new PizZip(content);
  const doc = parseXml(zip.files['word/document.xml'].asText());
  return analyzeBody(bodyOf(doc.root)).schema;
}

/**
 * Вписывает значения в области ввода (таблицы/абзацы/подчёркнутые пробелы)
 * и возвращает готовый .docx.
 */
export function autofillDocx(content: Buffer, values: Record<string, unknown>): Buffer {
  const zip = new PizZip(content);
  const part = zip.files['word/document.xml'];
  if (!part) throw new Error('В шаблоне нет word/document.xml');

  const doc = parseXml(part.asText());
  const body = bodyOf(doc.root);
  const paras = childrenOf(body, 'w:p');
  const tables = childrenOf(body, 'w:tbl');
  const { plan } = analyzeBody(body);

  const used = new Set<string>();
  for (const it of plan) {
    const raw = values[it.field];
    // `val in (None, "")` в Python: 0 и False считаются заполненными.
    const filled = raw !== null && raw !== undefined && raw !== '';
    if (it.kind === 'table') {
      // Ячейку чистим даже без значения — иначе в бланке останется старый текст.
      if (used.has(it.field)) continue;
      used.add(it.field);
      const tbl = tables[it.tableIdx];
      if (tbl) setCellValue(tbl, filled ? pyStr(raw) : '');
    } else if (it.kind === 'para') {
      if (!filled || used.has(it.field)) continue;
      used.add(it.field);
      const p = paras[it.paraIdx];
      if (p) addUnderlinedRun(p, pyStr(raw));
    } else {
      if (!filled || used.has(it.field)) continue;
      used.add(it.field);
      const p = paras[it.paraIdx];
      if (p) fillUspace(p, it.runIdx, pyStr(raw));
    }
  }

  zip.file('word/document.xml', serializeXml(doc));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

/**
 * Версия бланка ДЛЯ ПОКАЗА: области ввода заполнены названиями полей
 * [в скобках]. Порт render_field_preview из autofill.py.
 *
 * Отличие от autofillDocx: таблицы заполняются ВСЕ (одно поле может занимать
 * несколько ячеек-«клеточек»), а абзацы и подчёркнутые пробелы — только первый
 * раз на поле. Так же, как в Python.
 */
export function renderFieldPreviewDocx(content: Buffer): Buffer {
  const zip = new PizZip(content);
  const part = zip.files['word/document.xml'];
  if (!part) throw new Error('В шаблоне нет word/document.xml');

  const doc = parseXml(part.asText());
  const body = bodyOf(doc.root);
  const paras = childrenOf(body, 'w:p');
  const tables = childrenOf(body, 'w:tbl');
  const { schema, plan } = analyzeBody(body);
  const labels = new Map(schema.map((f) => [f.name, f.label]));

  const seen = new Set<string>();
  for (const it of plan) {
    if (seen.has(it.field) && it.kind !== 'table') continue;
    seen.add(it.field);
    const label = `[${labels.get(it.field) ?? it.field}]`;
    if (it.kind === 'table') {
      const tbl = tables[it.tableIdx];
      if (tbl) setCellValue(tbl, label);
    } else if (it.kind === 'para') {
      const p = paras[it.paraIdx];
      if (p) addUnderlinedRun(p, label);
    } else {
      const p = paras[it.paraIdx];
      if (p) fillUspace(p, it.runIdx, label);
    }
  }

  zip.file('word/document.xml', serializeXml(doc));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

