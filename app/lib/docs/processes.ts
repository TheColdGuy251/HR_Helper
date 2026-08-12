import 'server-only';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { baseName, suffixOf } from '@/lib/news';
import { convertToModern } from '@/lib/parsers/office-convert';
import { readZipEntries } from './zip';
import { innerText, isElement, parseXml, type XElement, type XNode } from './xml';

/**
 * А10: приведение схем процессов «из разных программ Microsoft» к единому виду.
 * Порт backend/services/processes.py.
 *
 * Экстрактор графа процесса из docx / pptx / xlsx (старые .doc/.ppt/.xls — через
 * LibreOffice-конвертацию): фигуры с текстом — узлы, коннекторы — рёбра
 * (направление по логической привязке stCxn/endCxn или по наконечникам стрелок),
 * короткие несоединённые надписи — роли блоков («УРП», «Ректор») либо метки
 * условий на стрелках («с командировкой», «отказ»). Затем послойный автолейаут
 * и рендер в SVG в едином стиле ТИУ.
 *
 * Всё детерминированное, без LLM.
 */

const EMU_MATCH = 700_000; // макс. расстояние конца стрелки до блока (~0.77 см)
const LABEL_MAX_CHARS = 60; // длиннее — точно блок, а не подпись

// ── мелочи, повторяющие поведение Python ───────────────────────────────────

/** Локальное имя тега: у ElementTree это часть после '}', здесь — после ':'. */
function lc(tag: string): string {
  const i = tag.lastIndexOf(':');
  return i < 0 ? tag : tag.slice(i + 1);
}

function prefixOf(tag: string): string {
  const i = tag.indexOf(':');
  return i < 0 ? '' : tag.slice(0, i);
}

function norm(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** str.split() без аргументов: режет по любым пробелам, пустые отбрасывает. */
function pySplit(s: string): string[] {
  return s.split(/\s+/).filter((x) => x !== '');
}

/** Первый символ — строчная буква (str[:1].islower()). */
function firstIsLower(s: string): boolean {
  const ch = Array.from(s)[0];
  return ch !== undefined && /\p{Ll}/u.test(ch);
}

/** str.isupper(): все буквы прописные и есть хотя бы одна буква. */
function pyIsUpper(s: string): boolean {
  let cased = false;
  for (const ch of s) {
    if (/\p{Ll}|\p{Lt}/u.test(ch)) return false;
    if (/\p{Lu}/u.test(ch)) cased = true;
  }
  return cased;
}

/** round() из Python: половина округляется к чётному, а не «от нуля». */
function pyRound(v: number): number {
  const fl = Math.floor(v);
  const diff = v - fl;
  if (diff > 0.5) return fl + 1;
  if (diff < 0.5) return fl;
  return fl % 2 === 0 ? fl : fl + 1;
}

/** format(v, '.0f'): та же половина к чётному + «-0» у отрицательных дробей. */
function f0(v: number): string {
  const r = pyRound(v);
  return r === 0 && v < 0 ? '-0' : String(r);
}

/**
 * str(float) из Python: целые печатаются с «.0» («467.0»), а не «467».
 * В SVG это попадает в viewBox/height, поэтому расхождение было бы видно.
 */
function pyFloat(v: number): string {
  return Number.isInteger(v) && Math.abs(v) < 1e16 ? `${v}.0` : String(v);
}

/** html.escape(s, quote=True). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── обход XML ──────────────────────────────────────────────────────────────

/** Префикс → URI: нужен единственный раз — отличить w:p (Word) от a:p (DrawingML). */
export type NsMap = Map<string, string>;

interface XDoc {
  root: XElement;
  ns: NsMap;
}

function loadXml(source: string | Buffer): XDoc {
  const { root } = parseXml(typeof source === 'string' ? source : source.toString('utf8'));
  const ns: NsMap = new Map();
  const walk = (el: XElement) => {
    for (const [k, v] of Object.entries(el.attrs)) {
      if (k.startsWith('xmlns:')) ns.set(k.slice(6), decodeXml(v));
    }
    for (const c of el.children) if (isElement(c)) walk(c);
  };
  walk(root);
  return { root, ns };
}

/** Развернуть XML-сущности в строке (значения атрибутов парсер хранит сырыми). */
function decodeXml(raw: string): string {
  if (!raw.includes('&')) return raw;
  return innerText({
    kind: 'el',
    tag: '',
    attrsRaw: '',
    attrs: {},
    children: [{ kind: 'raw', text: raw }],
    empty: false,
  });
}

function attr(el: XElement, name: string): string | undefined {
  const raw = el.attrs[name];
  return raw === undefined ? undefined : decodeXml(raw);
}

/** Атрибут с любым префиксом и локальным именем name (в ET это '{ns}name'). */
function nsAttr(el: XElement, name: string): string | undefined {
  for (const [k, v] of Object.entries(el.attrs)) {
    const i = k.indexOf(':');
    if (i > 0 && k.slice(i + 1) === name) return decodeXml(v);
  }
  return undefined;
}

/** ET.Element.iter(): сам элемент и все потомки в порядке документа. */
function* iterAll(el: XElement): Generator<XElement> {
  yield el;
  for (const c of el.children) {
    if (isElement(c)) yield* iterAll(c);
  }
}

/** Прямые дочерние элементы (for c in el). */
function kids(el: XElement): XElement[] {
  return el.children.filter(isElement);
}

/**
 * ET.Element.text: текст ДО первого дочернего элемента (хвосты не считаются).
 * Для <a:t>…</a:t> совпадает с полным текстом, но семантику держим точной.
 */
function etText(el: XElement): string {
  const lead: XNode[] = [];
  for (const c of el.children) {
    if (isElement(c)) break;
    lead.push(c);
  }
  if (!lead.length) return '';
  return innerText({ ...el, children: lead });
}

// ── Сырые фигуры из XML ────────────────────────────────────────────────────

export interface Shape {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  isConn: boolean;
  flipH: boolean;
  flipV: boolean;
  /** Наконечник на конце линии. */
  tail: boolean;
  /** Наконечник в начале линии. */
  head: boolean;
  dashed: boolean;
  /** Логическая привязка коннектора (pptx/xlsx). */
  stId: string | null;
  enId: string | null;
  shapeId: string | null;
}

function shape(init: Partial<Shape> & Pick<Shape, 'text' | 'x' | 'y' | 'w' | 'h' | 'isConn'>): Shape {
  return {
    flipH: false,
    flipV: false,
    tail: false,
    head: false,
    dashed: false,
    stId: null,
    enId: null,
    shapeId: null,
    ...init,
  };
}

const cxOf = (s: Shape) => s.x + s.w / 2;
const cyOf = (s: Shape) => s.y + s.h / 2;

const WORDML_NS = 'http://schemas.openxmlformats.org/wordprocessingml';

/** Абзацы текста фигуры (a:p → a:t), склеенные через перенос. */
function shapeText(el: XElement, ns: NsMap): string {
  const lines: string[] = [];
  for (const p of iterAll(el)) {
    if (lc(p.tag) !== 'p') continue;
    if ((ns.get(prefixOf(p.tag)) || '').startsWith(WORDML_NS)) continue;
    const buf: string[] = [];
    for (const t of iterAll(p)) {
      if (lc(t.tag) === 't') {
        const txt = etText(t);
        if (txt) buf.push(txt);
      }
    }
    const line = norm(buf.join(''));
    if (line) lines.push(line);
  }
  // docx: текст лежит в w:p/w:t
  if (!lines.length) {
    for (const p of iterAll(el)) {
      if (lc(p.tag) !== 'p') continue;
      const buf: string[] = [];
      for (const t of iterAll(p)) {
        if (lc(t.tag) === 't') {
          const txt = etText(t);
          if (txt) buf.push(txt);
        }
      }
      const line = norm(buf.join(''));
      if (line && !lines.includes(line)) lines.push(line);
    }
  }
  // дедуп (mc:Fallback дублирует текст)
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const x of lines) {
    const k = x.toLowerCase();
    if (!seen.has(k)) uniq.push(x);
    seen.add(k);
  }
  return uniq.join('\n');
}

/** (prst, tail, head, dashed) по prstGeom / tailEnd / headEnd / prstDash. */
function shapeFlags(el: XElement): [string, boolean, boolean, boolean] {
  let prst = '';
  let tail = false;
  let head = false;
  let dashed = false;
  for (const e of iterAll(el)) {
    const name = lc(e.tag);
    if (name === 'prstGeom' && !prst) prst = (attr(e, 'prst') || '').toLowerCase();
    else if (name === 'tailEnd' && (attr(e, 'type') || 'none') !== 'none') tail = true;
    else if (name === 'headEnd' && (attr(e, 'type') || 'none') !== 'none') head = true;
    else if (name === 'prstDash' && (attr(e, 'val') || '').includes('dash')) dashed = true;
  }
  return [prst, tail, head, dashed];
}

function cxnRefs(el: XElement): [string | null, string | null] {
  let st: string | null = null;
  let en: string | null = null;
  for (const e of iterAll(el)) {
    const name = lc(e.tag);
    if (name === 'stCxn') st = attr(e, 'id') ?? null;
    else if (name === 'endCxn') en = attr(e, 'id') ?? null;
  }
  return [st, en];
}

function spId(el: XElement): string | null {
  for (const e of iterAll(el)) {
    if (lc(e.tag) === 'cNvPr') return attr(e, 'id') ?? null;
  }
  return null;
}

type Geom = [number | null, number | null, number, number, boolean, boolean];

/** Геометрия из a:xfrm (pptx/фигуры): off + ext + flip. */
function xfrmGeom(el: XElement): Geom {
  for (const e of iterAll(el)) {
    if (lc(e.tag) !== 'xfrm') continue;
    const fx = attr(e, 'flipH') === '1';
    const fy = attr(e, 'flipV') === '1';
    let x: number | null = null;
    let y: number | null = null;
    let w = 0;
    let h = 0;
    for (const c of kids(e)) {
      if (lc(c.tag) === 'off') {
        x = Number(attr(c, 'x') || 0);
        y = Number(attr(c, 'y') || 0);
      } else if (lc(c.tag) === 'ext') {
        w = Number(attr(c, 'cx') || 0);
        h = Number(attr(c, 'cy') || 0);
      }
    }
    return [x, y, w, h, fx, fy];
  }
  return [null, null, 0, 0, false, false];
}

/** Фигуры слайда pptx (p:sp / p:cxnSp) — координаты в a:xfrm. */
export function shapesFromPptxLike(root: XElement, ns: NsMap): Shape[] {
  const out: Shape[] = [];
  for (const el of iterAll(root)) {
    const name = lc(el.tag);
    if (name !== 'sp' && name !== 'cxnSp') continue;
    const [x, y, w, h, fh, fv] = xfrmGeom(el);
    if (x === null) continue;
    const [prst, tail, head, dashed] = shapeFlags(el);
    const isConn = name === 'cxnSp' || prst.includes('connector') || prst === 'line' || prst.includes('arrow');
    const [st, en] = isConn ? cxnRefs(el) : [null, null];
    out.push(
      shape({
        text: shapeText(el, ns),
        x,
        y: y ?? 0,
        w,
        h,
        isConn,
        flipH: fh,
        flipV: fv,
        tail,
        head,
        dashed,
        stId: st,
        enId: en,
        shapeId: spId(el),
      })
    );
  }
  return out;
}

/**
 * Геометрия плавающей фигуры Word: координата (posOffset, EMU), размер (extent)
 * и отражение (flipH/flipV). Порт _anchor_geometry из services/parsers/docx.py —
 * в lib/parsers его нет, docx там читает mammoth, который фигур не видит.
 */
function ownOffset(anchor: XElement, which: string): number | null {
  for (const e of iterAll(anchor)) {
    if (lc(e.tag) !== which) continue;
    for (const c of kids(e)) {
      if (lc(c.tag) === 'posOffset') {
        const txt = etText(c);
        if (txt) {
          const v = Number.parseInt(txt, 10);
          return Number.isNaN(v) ? null : v;
        }
      }
    }
  }
  return null;
}

function anchorGeometry(anchor: XElement): Geom {
  const x = ownOffset(anchor, 'positionH');
  const y = ownOffset(anchor, 'positionV');
  let cx = 0;
  let cy = 0;
  for (const e of iterAll(anchor)) {
    if (lc(e.tag) === 'extent') {
      cx = Number.parseInt(attr(e, 'cx') || '0', 10) || 0;
      cy = Number.parseInt(attr(e, 'cy') || '0', 10) || 0;
      break;
    }
  }
  let flipH = false;
  let flipV = false;
  for (const e of iterAll(anchor)) {
    if (lc(e.tag) === 'xfrm') {
      flipH = attr(e, 'flipH') === '1';
      flipV = attr(e, 'flipV') === '1';
      break;
    }
  }
  return [x, y, cx, cy, flipH, flipV];
}

/** Плавающие фигуры Word (wp:anchor / wp:inline) — абсолютный posOffset. */
export function shapesFromDocx(root: XElement, ns: NsMap): Shape[] {
  const out: Shape[] = [];
  for (const el of iterAll(root)) {
    const name = lc(el.tag);
    if (name !== 'anchor' && name !== 'inline') continue;
    const [x, y, w, h, fh, fv] = anchorGeometry(el);
    if (x === null || y === null) continue;
    const [prst, tail, head, dashed] = shapeFlags(el);
    const isConn = prst.includes('connector') || prst === 'line' || prst.includes('arrow');
    out.push(
      shape({
        text: shapeText(el, ns),
        x,
        y,
        w,
        h,
        isConn,
        flipH: fh,
        flipV: fv,
        tail,
        head,
        dashed,
      })
    );
  }
  return out;
}

// ── xlsx: клетки как блоки, drawing как стрелки ────────────────────────────

type Axis = (i: number) => number;

function xlsxAnchorPt(el: XElement, colx: Axis, rowy: Axis): [number, number] | null {
  let col: number | null = null;
  let row: number | null = null;
  let coff: number | null = null;
  let roff: number | null = null;
  for (const c of kids(el)) {
    const name = lc(c.tag);
    const v = () => Number.parseInt(etText(c) || '0', 10) || 0;
    if (name === 'col') col = v();
    else if (name === 'colOff') coff = v();
    else if (name === 'row') row = v();
    else if (name === 'rowOff') roff = v();
  }
  if (col === null || row === null) return null;
  return [colx(col) + (coff || 0), rowy(row) + (roff || 0)];
}

/**
 * Стрелки/фигуры листа Excel (xdr:*CellAnchor). Координаты якорей — клетки,
 * переводятся в EMU по РЕАЛЬНЫМ ширинам колонок и высотам строк (colx/rowy).
 */
export function shapesFromXlsxDrawing(
  root: XElement,
  ns: NsMap,
  colx: Axis,
  rowy: Axis
): Shape[] {
  const out: Shape[] = [];
  for (const anch of iterAll(root)) {
    const kind = lc(anch.tag);
    if (kind !== 'twoCellAnchor' && kind !== 'oneCellAnchor' && kind !== 'absoluteAnchor') continue;
    let frm: [number, number] | null = null;
    let to: [number, number] | null = null;
    let body: XElement | null = null;
    for (const c of kids(anch)) {
      const name = lc(c.tag);
      if (name === 'from') frm = xlsxAnchorPt(c, colx, rowy);
      else if (name === 'to') to = xlsxAnchorPt(c, colx, rowy);
      else if (name === 'sp' || name === 'cxnSp' || name === 'grpSp') body = c;
    }
    if (frm === null || body === null) continue;
    if (to === null) to = [frm[0] + 1_000_000, frm[1] + 400_000];
    const x = Math.min(frm[0], to[0]);
    const y = Math.min(frm[1], to[1]);
    const w = Math.abs(to[0] - frm[0]);
    const h = Math.abs(to[1] - frm[1]);
    const [prst, tail, head, dashed] = shapeFlags(body);
    const isConn =
      lc(body.tag) === 'cxnSp' || prst.includes('connector') || prst === 'line' || prst.includes('arrow');
    const [st, en] = isConn ? cxnRefs(body) : [null, null];
    out.push(
      shape({
        text: shapeText(body, ns),
        x,
        y,
        w,
        h,
        isConn,
        // Направление xlsx-коннектора задаётся якорями from/to
        flipH: frm[0] > to[0],
        flipV: frm[1] > to[1],
        tail,
        head,
        dashed,
        stId: st,
        enId: en,
        shapeId: spId(body),
      })
    );
  }
  return out;
}

// Чтение книги: openpyxl здесь заменить нечем — SheetJS не отдаёт ни ширины
// колонок в «символах», ни max_row по стилизованным пустым ячейкам, а от них
// зависят координаты якорей. Поэтому лист разбирается прямо из XML.

type CellValue = string | number | boolean | Date | { int: string };

interface ParsedSheet {
  title: string;
  cells: Map<string, CellValue>;
  maxRow: number;
  maxCol: number;
  /** Ширина в «символах» по индексу колонки, где начинается <col> (как в openpyxl). */
  colWidth: Map<number, number>;
  /** Высота строки в пунктах. */
  rowHeight: Map<number, number>;
  merges: { r1: number; c1: number; r2: number; c2: number }[];
}

/** «A12» → [12, 1]. */
function coordToTuple(ref: string): [number, number] {
  let col = 0;
  let i = 0;
  for (; i < ref.length; i += 1) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    col = col * 26 + (c - 64);
  }
  return [Number.parseInt(ref.slice(i), 10) || 0, col];
}

/** str(value) для ячейки — как его печатает Python. */
function cellToPyString(v: CellValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return pyFloat(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof Date) {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const ms = v.getUTCMilliseconds();
    const base =
      `${p(v.getUTCFullYear(), 4)}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())} ` +
      `${p(v.getUTCHours())}:${p(v.getUTCMinutes())}:${p(v.getUTCSeconds())}`;
    return ms ? `${base}.${p(ms * 1000, 6)}` : base;
  }
  return v.int;
}

// Встроенные числовые форматы Excel, которые openpyxl считает датами
// (is_date_format по BUILTIN_FORMATS — только эти id дают True).
const DATE_BUILTINS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** openpyxl.styles.numbers.is_date_format — для пользовательских форматов. */
function isDateFormat(fmt: string): boolean {
  const head = fmt.split(';')[0].replace(/".*?"|\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/g, '');
  return /(?<![_\\])[dmhysDMHYS]/.test(head);
}

/** Индексы cellXfs, у которых числовой формат — дата (wb._date_formats). */
function dateStyleIds(stylesXml: Buffer | undefined): Set<number> {
  const out = new Set<number>();
  if (!stylesXml) return out;
  const { root } = loadXml(stylesXml);
  const custom = new Map<number, string>();
  for (const e of iterAll(root)) {
    if (lc(e.tag) !== 'numFmt') continue;
    const id = Number.parseInt(attr(e, 'numFmtId') || '', 10);
    if (!Number.isNaN(id)) custom.set(id, attr(e, 'formatCode') || '');
  }
  const cellXfs = [...iterAll(root)].find((e) => lc(e.tag) === 'cellXfs');
  if (!cellXfs) return out;
  kids(cellXfs).forEach((xf, idx) => {
    const id = Number.parseInt(attr(xf, 'numFmtId') || '0', 10) || 0;
    const code = custom.get(id);
    if (code !== undefined ? isDateFormat(code) : DATE_BUILTINS.has(id)) out.add(idx);
  });
  return out;
}

/** openpyxl._cast_number: «5» → int, «5.0» → float (str() у них разный). */
function castNumber(raw: string): CellValue {
  if (/[.Ee]/.test(raw)) return Number(raw);
  try {
    return { int: String(BigInt(raw)) };
  } catch {
    return Number(raw);
  }
}

/** openpyxl.utils.datetime.from_excel для обычного случая «дата+время». */
function fromExcelSerial(value: number): Date {
  const day = Math.floor(value);
  const fraction = value - day;
  const msInDay = pyRound(fraction * 86400 * 1000);
  // Excel считает 1900 високосным: серийные номера < 60 сдвинуты на день.
  const shifted = value > 0 && value < 60 ? day + 1 : day;
  return new Date(Date.UTC(1899, 11, 30) + shifted * 86_400_000 + msInDay);
}

/** Тексты всех <t> внутри элемента (общий сборщик для si / is). */
function collectT(el: XElement): string {
  let out = '';
  for (const e of iterAll(el)) if (lc(e.tag) === 't') out += etText(e);
  return out;
}

function readSharedStrings(xml: Buffer | undefined): string[] {
  if (!xml) return [];
  const { root } = loadXml(xml);
  return kids(root)
    .filter((e) => lc(e.tag) === 'si')
    .map(collectT);
}

function parseSheet(
  title: string,
  xml: Buffer,
  shared: string[],
  dateStyles: Set<number>
): ParsedSheet {
  const { root } = loadXml(xml);
  const sheet: ParsedSheet = {
    title,
    cells: new Map(),
    maxRow: 1,
    maxCol: 1,
    colWidth: new Map(),
    rowHeight: new Map(),
    merges: [],
  };
  let haveCells = false;
  let rowCounter = 0;

  for (const e of iterAll(root)) {
    const name = lc(e.tag);
    if (name === 'col') {
      // openpyxl заводит ColumnDimension ТОЛЬКО под буквой min: <col min=3 max=16384>
      // задаёт ширину лишь колонке C, остальные получают дефолтные 8.43.
      const min = Number.parseInt(attr(e, 'min') || '', 10);
      const width = Number.parseFloat(attr(e, 'width') || '');
      if (!Number.isNaN(min)) sheet.colWidth.set(min, Number.isNaN(width) ? 0 : width);
    } else if (name === 'mergeCell') {
      const ref = attr(e, 'ref') || '';
      const [a, b] = ref.split(':');
      if (a && b) {
        const [r1, c1] = coordToTuple(a);
        const [r2, c2] = coordToTuple(b);
        sheet.merges.push({ r1, c1, r2, c2 });
      }
    } else if (name === 'row') {
      const r = attr(e, 'r');
      rowCounter = r ? Number.parseInt(r, 10) : rowCounter + 1;
      const ht = attr(e, 'ht');
      if (ht !== undefined) sheet.rowHeight.set(rowCounter, Number.parseFloat(ht));
      let colCounter = 0;
      for (const c of kids(e)) {
        if (lc(c.tag) !== 'c') continue;
        const ref = attr(c, 'r');
        let row = rowCounter;
        let col: number;
        if (ref) {
          [row, col] = coordToTuple(ref);
          colCounter = col;
        } else {
          colCounter += 1;
          col = colCounter;
        }
        // Ячейка учитывается в max_row/max_column, даже если значения нет.
        haveCells = true;
        if (row > sheet.maxRow) sheet.maxRow = row;
        if (col > sheet.maxCol) sheet.maxCol = col;

        const type = attr(c, 't') || 'n';
        const styleId = Number.parseInt(attr(c, 's') || '0', 10) || 0;
        const vEl = kids(c).find((k) => lc(k.tag) === 'v');
        const raw = vEl ? etText(vEl) : '';
        let value: CellValue | null = null;
        if (raw) {
          if (type === 'n') {
            // _cast_number: без точки и экспоненты это int, а str(int) ≠ str(float).
            value = dateStyles.has(styleId) ? fromExcelSerial(Number(raw)) : castNumber(raw);
          } else if (type === 's') {
            value = shared[Number.parseInt(raw, 10)] ?? '';
          } else if (type === 'b') {
            value = Number(raw) !== 0;
          } else {
            value = raw; // str / e / d — openpyxl отдаёт строку
          }
        } else if (type === 'inlineStr') {
          const is = kids(c).find((k) => lc(k.tag) === 'is');
          if (is) value = collectT(is);
        }
        if (value !== null) sheet.cells.set(`${row}:${col}`, value);
      }
    }
  }
  if (!haveCells) {
    sheet.maxRow = 1;
    sheet.maxCol = 1;
  }
  return sheet;
}

/** Полный путь части по Target из .rels (Target бывает относительным). */
function relTarget(target: string): string {
  return `xl/${target.replace(/\.\.\//g, '').replace(/^\/+/, '')}`;
}

/**
 * Наборы фигур по листам Excel: БЛОКИ схемы — это заполненные ЯЧЕЙКИ
 * (в т.ч. объединённые), стрелки — фигуры из drawingN.xml того же листа.
 */
function xlsxSheetShapeSets(zip: Map<string, Buffer>): Shape[][] {
  const readXml = (n: string) => {
    const buf = zip.get(n);
    return buf ? loadXml(buf) : null;
  };

  // sheet name → файл листа (workbook.xml → rels → target)
  const wbRoot = readXml('xl/workbook.xml');
  const wbRels = readXml('xl/_rels/workbook.xml.rels');
  const rid2target = new Map<string, string>();
  if (wbRels) {
    for (const r of kids(wbRels.root)) {
      const id = attr(r, 'Id');
      if (id) rid2target.set(id, (attr(r, 'Target') || '').replace(/^\/+/, ''));
    }
  }
  const sheetFile = new Map<string, string>();
  if (wbRoot) {
    for (const s of iterAll(wbRoot.root)) {
      if (lc(s.tag) !== 'sheet') continue;
      const rid = nsAttr(s, 'id');
      let tgt = (rid && rid2target.get(rid)) || '';
      if (tgt && !tgt.startsWith('xl/')) tgt = `xl/${tgt}`;
      sheetFile.set(attr(s, 'name') || '', tgt);
    }
  }

  const drawingOf = new Map<string, string>();
  for (const [name, sf] of sheetFile) {
    if (!sf || !zip.has(sf)) continue;
    const sroot = readXml(sf);
    const dir = sf.slice(0, sf.lastIndexOf('/'));
    const base = sf.slice(sf.lastIndexOf('/') + 1);
    const rels = readXml(`${dir}/_rels/${base}.rels`);
    let drid: string | undefined;
    if (sroot) {
      for (const e of iterAll(sroot.root)) {
        if (lc(e.tag) === 'drawing') drid = nsAttr(e, 'id');
      }
    }
    if (drid && rels) {
      for (const r of kids(rels.root)) {
        if (attr(r, 'Id') === drid) drawingOf.set(name, relTarget(attr(r, 'Target') || ''));
      }
    }
  }

  const shared = readSharedStrings(zip.get('xl/sharedStrings.xml'));
  const dateStyles = dateStyleIds(zip.get('xl/styles.xml'));

  const sets: Shape[][] = [];
  for (const [title, sf] of sheetFile) {
    const buf = sf ? zip.get(sf) : undefined;
    if (!buf) continue;
    const ws = parseSheet(title, buf, shared, dateStyles);

    // Кумулятивные координаты колонок/строк в EMU (ширина в символах ≈ 7px/симв.)
    const maxCol = Math.min(ws.maxCol || 1, 60) + 4;
    const maxRow = Math.min(ws.maxRow || 1, 300) + 4;
    const cumX = [0];
    for (let i = 1; i <= maxCol; i += 1) {
      const w = ws.colWidth.get(i);
      const chars = w ? w : 8.43;
      cumX.push(cumX[cumX.length - 1] + pyRound(chars * 7) * 9525);
    }
    const cumY = [0];
    for (let i = 1; i <= maxRow; i += 1) {
      const ht = ws.rowHeight.get(i);
      const pts = ht ? ht : 15.0;
      cumY.push(cumY[cumY.length - 1] + pyRound(pts * 12700));
    }
    const colx: Axis = (c) => cumX[Math.min(c, cumX.length - 1)];
    const rowy: Axis = (r) => cumY[Math.min(r, cumY.length - 1)];

    const shapes: Shape[] = [];
    // Объединённые ячейки → блоки
    const mergedCells = new Set<string>();
    for (const rng of ws.merges) {
      const v = ws.cells.get(`${rng.r1}:${rng.c1}`);
      for (let rr = rng.r1; rr <= rng.r2; rr += 1) {
        for (let cc = rng.c1; cc <= rng.c2; cc += 1) mergedCells.add(`${rr}:${cc}`);
      }
      const text = v === undefined ? '' : norm(cellToPyString(v));
      if (!text) continue;
      const x = colx(rng.c1 - 1);
      const y = rowy(rng.r1 - 1);
      shapes.push(
        shape({ text, x, y, w: colx(rng.c2) - x, h: rowy(rng.r2) - y, isConn: false })
      );
    }
    // Одиночные заполненные ячейки
    const rowLimit = Math.min(ws.maxRow || 1, 300);
    for (let r = 1; r <= rowLimit; r += 1) {
      for (let c = 1; c <= ws.maxCol; c += 1) {
        const key = `${r}:${c}`;
        const v = ws.cells.get(key);
        if (v === undefined || mergedCells.has(key)) continue;
        const text = norm(cellToPyString(v));
        if (!text) continue;
        const x = colx(c - 1);
        const y = rowy(r - 1);
        shapes.push(shape({ text, x, y, w: colx(c) - x, h: rowy(r) - y, isConn: false }));
      }
    }
    // Стрелки листа
    const drawing = drawingOf.get(title);
    const dbuf = drawing ? zip.get(drawing) : undefined;
    if (dbuf) {
      const doc = loadXml(dbuf);
      shapes.push(...shapesFromXlsxDrawing(doc.root, doc.ns, colx, rowy));
    }
    if (shapes.length) sets.push(shapes);
  }
  return sets;
}

// ── обход частей контейнера ────────────────────────────────────────────────

/** Наборы фигур-кандидатов (по одному на «полотно»: документ/слайды/лист). */
export async function collectShapeSets(file: string): Promise<Shape[][]> {
  const suffix = suffixOf(baseName(file)).toLowerCase();
  const zip = new Map<string, Buffer>();
  for (const e of readZipEntries(await readFile(file))) {
    if (!e.dir) zip.set(e.name, e.read());
  }

  if (suffix === '.docx') {
    const buf = zip.get('word/document.xml');
    if (!buf) throw new Error('There is no item named word/document.xml in the archive');
    const doc = loadXml(buf);
    return [shapesFromDocx(doc.root, doc.ns)];
  }
  if (suffix === '.pptx') {
    // Порядок как у sorted() в Python — лексикографический, а не по номеру.
    const slides = [...zip.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
    return slides.map((n) => {
      const doc = loadXml(zip.get(n) as Buffer);
      return shapesFromPptxLike(doc.root, doc.ns);
    });
  }
  if (suffix === '.xlsx' || suffix === '.xlsm') return xlsxSheetShapeSets(zip);
  return [];
}

// ── Сборка графа: блоки / роли / рёбра / метки условий ─────────────────────

export interface PNode {
  id: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  role: string | null;
  dashed: boolean;
}

export interface PEdge {
  src: number;
  dst: number;
  label: string | null;
  dashed: boolean;
}

export interface ProcessGraph {
  title: string | null;
  nodes: PNode[];
  edges: PEdge[];
}

function ptRectDist(px: number, py: number, s: Shape): number {
  const dx = Math.max(s.x - px, 0, px - (s.x + s.w));
  const dy = Math.max(s.y - py, 0, py - (s.y + s.h));
  return Math.sqrt(dx * dx + dy * dy);
}

function looksLikeLabel(s: Shape): boolean {
  const t = s.text.replace(/\n/g, ' ');
  const len = Array.from(t).length;
  return len > 0 && len <= LABEL_MAX_CHARS && pySplit(t).length <= 7;
}

/**
 * Извлекает граф процесса из файла со схемой (лучшее «полотно» файла).
 * null — схема не распознана (нет блоков со стрелками, либо она — картинка).
 */
export async function extractProcessGraph(file: string): Promise<ProcessGraph | null> {
  let target = file;
  let tmpDir: string | null = null;
  if (['.doc', '.ppt', '.xls'].includes(suffixOf(baseName(file)).toLowerCase())) {
    target = await convertToModern(file);
    tmpDir = path.dirname(target);
  }
  try {
    let sets: Shape[][];
    try {
      sets = await collectShapeSets(target);
    } catch (e) {
      console.warn(
        `[PROCESS] не удалось прочитать фигуры ${baseName(target)}: ${e instanceof Error ? e.message : e}`
      );
      return null;
    }
    let best: ProcessGraph | null = null;
    for (const shapes of sets) {
      const g = assembleGraph(shapes);
      if (g && (best === null || g.nodes.length > best.nodes.length)) best = g;
    }
    return best;
  } finally {
    // Python временный каталог конвертации не убирает — здесь чистим за собой.
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function assembleGraph(shapes: Shape[]): ProcessGraph | null {
  // «? …» — комментарии-идеи на полях схем (не шаги процесса)
  const texted = shapes.filter((s) => s.text && !s.isConn && !s.text.replace(/^\s+/, '').startsWith('?'));
  const conns = shapes.filter((s) => s.isConn);
  if (texted.length < 2 || !conns.length) return null;

  // Надпись со строчной буквы («согласовано», «с командировкой») — метка
  // условия; короткая аббревиатура КАПСОМ («УРП», «ДЭФИ») — роль-дорожка.
  // Ни то ни другое не шаг процесса: исключаем из привязки концов стрелок.
  const forcedLabel = (s: Shape): boolean => {
    const t = s.text.replace(/\n/g, ' ');
    const len = Array.from(t).length;
    return (len <= 30 && firstIsLower(t)) || (len <= 6 && pyIsUpper(t));
  };

  const idBySpid = new Map<string, Shape>();
  for (const s of texted) if (s.shapeId) idBySpid.set(s.shapeId, s);
  const matchPool = texted.filter((s) => !forcedLabel(s));

  // 1) Рёбра: логические привязки (pptx/xlsx) → геометрия концов линии.
  const rawEdges: [Shape, Shape, Shape][] = [];

  /**
   * Ближайший блок к точке; короткие подписи (роли) — со штрафом, чтобы
   * конец стрелки у заголовка колонки не «прилипал» к нему вместо шага.
   */
  const nearestBlock = (px: number, py: number): [Shape | null, number] => {
    let best: Shape | null = null;
    let bd = 1e18;
    for (const b of matchPool) {
      let d = ptRectDist(px, py, b);
      if (looksLikeLabel(b)) d = d * 1.5 + 150_000;
      if (d < bd) {
        best = b;
        bd = d;
      }
    }
    return [best, bd];
  };

  for (const c of conns) {
    let src = c.stId ? idBySpid.get(c.stId) ?? null : null;
    let dst = c.enId ? idBySpid.get(c.enId) ?? null : null;
    if (src === null || dst === null) {
      const p1: [number, number] = [c.x + (c.flipH ? c.w : 0), c.y + (c.flipV ? c.h : 0)];
      const p2: [number, number] = [c.x + (c.flipH ? 0 : c.w), c.y + (c.flipV ? 0 : c.h)];
      // Наконечник tailEnd — на КОНЦЕ линии (p2): поток p1→p2; headEnd — наоборот.
      const [startPt, endPt] = c.head && !c.tail ? [p2, p1] : [p1, p2];
      const [start, d1] = nearestBlock(startPt[0], startPt[1]);
      const [end, d2] = nearestBlock(endPt[0], endPt[1]);
      let s1 = start;
      let s2 = end;
      if (!s1 || !s2 || s1 === s2 || d1 > EMU_MATCH || d2 > EMU_MATCH) continue;
      // линия без стрелки — сверху вниз / слева направо
      if (!c.tail && !c.head && gt2(cyOf(s1), cxOf(s1), cyOf(s2), cxOf(s2))) {
        [s1, s2] = [s2, s1];
      }
      src = s1;
      dst = s2;
    }
    if (src === dst) continue;
    rawEdges.push([src, dst, c]);
  }

  if (!rawEdges.length) return null;

  const connected = new Set<Shape>();
  for (const [a, b] of rawEdges) {
    connected.add(a);
    connected.add(b);
  }

  // 2) Несоединённые короткие надписи: заголовок, метка ребра или роль блока.
  const labels = texted.filter((s) => forcedLabel(s) || (!connected.has(s) && looksLikeLabel(s)));
  const labelSet = new Set(labels);
  const blocks = texted.filter((s) => !labelSet.has(s));
  if (blocks.length < 2) return null;

  // Заголовок схемы: надпись ВЫШЕ всех блоков, ШИРЕ типового блока (роли —
  // узкие подписи над конкретным блоком) и начинающаяся в левой половине.
  let title: string | null = null;
  if (labels.length) {
    const minBlockY = Math.min(...blocks.map((b) => b.y));
    const ws = blocks.map((b) => b.w).sort((a, b) => a - b);
    const medianW = ws[Math.floor(ws.length / 2)];
    const midX =
      (Math.min(...blocks.map((b) => b.x)) + Math.max(...blocks.map((b) => b.x + b.w))) / 2;
    const cands = labels.filter(
      (s) => s.y + s.h <= minBlockY && s.w >= 1.25 * medianW && s.x < midX
    );
    if (cands.length) {
      let top = cands[0];
      for (const s of cands) if (s.y < top.y) top = s;
      title = top.text.replace(/\n/g, ' ');
      // list.remove() в Python сравнивает по значению полей, не по ссылке
      const at = labels.findIndex((s) => shapeEq(s, top));
      if (at >= 0) labels.splice(at, 1);
    }
  }

  // Метка ребра — если её центр ближе к середине какой-то стрелки, чем к блокам.
  const edgeLabel = new Map<number, string>();
  const roles = new Map<Shape, string>();
  for (const lb of labels) {
    const lcx = cxOf(lb);
    const lcy = cyOf(lb);
    let bestE = -1;
    let bde = 1e18;
    for (let i = 0; i < rawEdges.length; i += 1) {
      const c = rawEdges[i][2];
      const mx = c.x + c.w / 2;
      const my = c.y + c.h / 2;
      const d = Math.sqrt((mx - lcx) ** 2 + (my - lcy) ** 2);
      if (d < bde) {
        bestE = i;
        bde = d;
      }
    }
    let bestB: Shape | null = null;
    let bdb = 1e18;
    for (const b of blocks) {
      const d = ptRectDist(lcx, lcy, b);
      if (d < bdb) {
        bestB = b;
        bdb = d;
      }
    }
    // Метка со строчной буквы — условие перехода: ТОЛЬКО на стрелку
    // (в сетке Excel она всегда вплотную к какому-нибудь блоку, поэтому
    // сравнение расстояний с блоками тут не работает). Прочие подписи —
    // роль ближайшего блока.
    const addLabel = (i: number) => {
      const prev = edgeLabel.get(i);
      // Внимание: в ветке склейки Python НЕ убирает перенос строки — повторяем.
      edgeLabel.set(i, prev ? `${prev} / ${lb.text}` : lb.text.replace(/\n/g, ' '));
    };
    if (firstIsLower(lb.text)) {
      if (bestE >= 0 && bde < EMU_MATCH * 3) addLabel(bestE);
      continue;
    }
    if (bestE >= 0 && bde < bdb && bde < EMU_MATCH * 2) {
      addLabel(bestE);
    } else if (bestB !== null && bdb < EMU_MATCH * 3) {
      // роль пишут НАД блоком или слева — принимаем ближайший блок
      if (!roles.has(bestB)) roles.set(bestB, lb.text.replace(/\n/g, ' '));
    }
  }

  const nodes: PNode[] = [];
  const idx = new Map<Shape, number>();
  const ordered = blocks
    .map((s, i) => [s, i] as const)
    .sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x || a[1] - b[1])
    .map(([s]) => s);
  for (const s of ordered) {
    idx.set(s, nodes.length);
    nodes.push({
      id: nodes.length,
      text: s.text,
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h,
      role: roles.get(s) ?? null,
      dashed: s.dashed,
    });
  }

  const edges: PEdge[] = [];
  const seenE = new Set<string>();
  rawEdges.forEach(([a, b, c], i) => {
    const ia = idx.get(a);
    const ib = idx.get(b);
    if (ia === undefined || ib === undefined) return;
    const label = edgeLabel.get(i) ?? null;
    // Ключ дедупликации (src, dst, label) — JSON безопасен для любых подписей.
    const key = JSON.stringify([ia, ib, label]);
    if (seenE.has(key)) return;
    seenE.add(key);
    edges.push({ src: ia, dst: ib, label, dashed: c.dashed });
  });

  return { title, nodes, edges };
}

/** Сравнение кортежей (a1, a2) > (b1, b2), как в Python. */
function gt2(a1: number, a2: number, b1: number, b2: number): boolean {
  return a1 !== b1 ? a1 > b1 : a2 > b2;
}

/** Равенство dataclass-ов _Shape (используется в labels.remove). */
function shapeEq(a: Shape, b: Shape): boolean {
  return (
    a.text === b.text && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h &&
    a.isConn === b.isConn && a.flipH === b.flipH && a.flipV === b.flipV &&
    a.tail === b.tail && a.head === b.head && a.dashed === b.dashed &&
    a.stId === b.stId && a.enId === b.enId && a.shapeId === b.shapeId
  );
}

// ── Автолейаут: слои по потоку (длиннейший путь), внутри слоя — по исходному y ──

const NODE_W = 230;
const GAP_X = 110;
const GAP_Y = 36;
const BAND_GAP = 70; // зазор между лентами «змейки»
const MAX_COLS = 4; // колонок в ленте (дальше — перенос на следующую)
const FONT = 13;
const LINE_H = 17;
const PAD = 12;
const CHARS_PER_LINE = 30;

function wrap(text: string, width = CHARS_PER_LINE): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    let cur = '';
    for (const w of pySplit(rawLine)) {
      const cand = `${cur} ${w}`.trim();
      if (Array.from(cand).length > width && cur) {
        out.push(cur);
        cur = w;
      } else {
        cur = cand;
      }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

interface Layout {
  pos: Map<number, [number, number, number, number]>;
  width: number;
  height: number;
}

export function layoutGraph(g: ProcessGraph): Layout {
  const n = g.nodes.length;
  const adj = new Map<number, number[]>();
  const indeg = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    adj.set(i, []);
    indeg.set(i, 0);
  }
  for (const e of g.edges) {
    adj.get(e.src)?.push(e.dst);
    indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
  }

  // Слой = длиннейший путь от источника (Kahn); циклы дожимаем по y.
  const level = new Map<number, number>();
  for (let i = 0; i < n; i += 1) level.set(i, 0);
  const sources: number[] = [];
  for (let i = 0; i < n; i += 1) if (indeg.get(i) === 0) sources.push(i);
  const q = sources.length ? sources : [0];
  const deg = new Map(indeg);
  const seen = new Set<number>();
  while (q.length) {
    const v = q.shift() as number;
    if (seen.has(v)) continue;
    seen.add(v);
    for (const u of adj.get(v) ?? []) {
      level.set(u, Math.max(level.get(u) ?? 0, (level.get(v) ?? 0) + 1));
      deg.set(u, (deg.get(u) ?? 0) - 1);
      if ((deg.get(u) ?? 0) <= 0) q.push(u);
    }
  }
  for (let i = 0; i < n; i += 1) {
    if (!seen.has(i) && [...seen].some((j) => (adj.get(j) ?? []).includes(i))) {
      level.set(i, Math.max(level.get(i) ?? 0, 1));
    }
  }

  const cols = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const lv = level.get(i) as number;
    const list = cols.get(lv);
    if (list) list.push(i);
    else cols.set(lv, [i]);
  }
  for (const ids of cols.values()) {
    ids.sort((a, b) => g.nodes[a].y - g.nodes[b].y || g.nodes[a].x - g.nodes[b].x);
  }

  const heights = new Map<number, number>();
  g.nodes.forEach((node, i) => {
    heights.set(i, wrap(node.text).length * LINE_H + PAD * 2 + (node.role ? 16 : 0));
  });

  // «Змейка»: длинная цепочка не должна растягиваться в километровую полосу —
  // уровни складываются в ленты по MAX_COLS колонок, лента под лентой.
  const levelKeys = [...cols.keys()];
  const nLevels = Math.max(...levelKeys) + 1;
  const perRow = Math.min(nLevels, MAX_COLS);
  const colH = new Map<number, number>();
  for (const [lv, ids] of cols) {
    colH.set(lv, ids.reduce((acc, i) => acc + (heights.get(i) as number), 0) + GAP_Y * (ids.length - 1));
  }

  const bandOf = new Map<number, number>();
  for (const lv of levelKeys) bandOf.set(lv, Math.floor(lv / MAX_COLS));
  const nBands = Math.max(...bandOf.values()) + 1;
  const bandH = new Map<number, number>();
  for (let b = 0; b < nBands; b += 1) {
    const inBand = levelKeys.filter((lv) => bandOf.get(lv) === b).map((lv) => colH.get(lv) as number);
    // В Python max() пустой ленты бросает ValueError → 500; поведение сохраняем.
    if (!inBand.length) throw new Error('max() arg is an empty sequence');
    bandH.set(b, Math.max(...inBand));
  }
  const bandY = new Map<number, number>();
  let yCursor = 70.0;
  for (let b = 0; b < nBands; b += 1) {
    bandY.set(b, yCursor);
    yCursor += (bandH.get(b) as number) + BAND_GAP;
  }

  const pos = new Map<number, [number, number, number, number]>();
  for (const lv of [...levelKeys].sort((a, b) => a - b)) {
    const b = bandOf.get(lv) as number;
    const x = 40 + (lv % MAX_COLS) * (NODE_W + GAP_X);
    let y = (bandY.get(b) as number) + ((bandH.get(b) as number) - (colH.get(lv) as number)) / 2;
    for (const i of cols.get(lv) as number[]) {
      const h = heights.get(i) as number;
      pos.set(i, [x, y, NODE_W, h]);
      y += h + GAP_Y;
    }
  }

  const width = 40 * 2 + perRow * NODE_W + (perRow - 1) * GAP_X;
  return { pos, width: Math.max(width, 460), height: yCursor - BAND_GAP + 50 };
}

// ── SVG в едином стиле ТИУ ─────────────────────────────────────────────────

const BLUE = '#1E40AF';
const INK = '#0F172A';
const MUTED = '#475569';

export function renderProcessSvg(g: ProcessGraph): string {
  const lt = layoutGraph(g);
  const pos = lt.pos;
  const W = String(lt.width);
  const H = pyFloat(lt.height);
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
      `width="${W}" height="${H}" ` +
      'font-family="Segoe UI, Arial, sans-serif">'
  );
  out.push(
    '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ' +
      'markerHeight="7" orient="auto-start-reverse">' +
      `<path d="M 0 0 L 10 5 L 0 10 z" fill="${MUTED}"/></marker></defs>`
  );
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="white"/>`);
  if (g.title) {
    out.push(
      `<text x="40" y="38" font-size="20" font-weight="700" fill="${INK}">` +
        `${escapeHtml(g.title)}</text>`
    );
    out.push(`<rect x="40" y="48" width="56" height="4" rx="2" fill="${BLUE}"/>`);
  }

  // Рёбра — под блоками
  for (const e of g.edges) {
    const [x1, y1, w1, h1] = pos.get(e.src) as [number, number, number, number];
    const [x2, y2, w2, h2] = pos.get(e.dst) as [number, number, number, number];
    let sx: number;
    let sy: number;
    let ex: number;
    let ey: number;
    let d: string;
    if (x2 > x1 + w1) {
      // вперёд по потоку: правая грань → левая грань
      [sx, sy, ex, ey] = [x1 + w1, y1 + h1 / 2, x2, y2 + h2 / 2];
      const mx = (sx + ex) / 2;
      d = `M ${f0(sx)} ${f0(sy)} C ${f0(mx)} ${f0(sy)} ${f0(mx)} ${f0(ey)} ${f0(ex - 3)} ${f0(ey)}`;
    } else if (y2 > y1 + h1 + 20) {
      // переход на ленту ниже («змейка»): вниз → вбок → вниз
      [sx, sy, ex, ey] = [x1 + w1 / 2, y1 + h1, x2 + w2 / 2, y2];
      const my = (sy + ey) / 2;
      d = `M ${f0(sx)} ${f0(sy)} L ${f0(sx)} ${f0(my)} L ${f0(ex)} ${f0(my)} L ${f0(ex)} ${f0(ey - 3)}`;
    } else if (x1 > x2 + w2) {
      // назад: дуга снизу
      [sx, sy, ex, ey] = [x1, y1 + h1 / 2, x2 + w2, y2 + h2 / 2];
      const dip = Math.max(y1 + h1, y2 + h2) + 40;
      d = `M ${f0(sx)} ${f0(sy)} C ${f0(sx - 60)} ${f0(dip)} ${f0(ex + 60)} ${f0(dip)} ${f0(ex + 3)} ${f0(ey)}`;
    } else {
      // один слой: вертикально
      if (y2 > y1) [sx, sy, ex, ey] = [x1 + w1 / 2, y1 + h1, x2 + w2 / 2, y2];
      else [sx, sy, ex, ey] = [x1 + w1 / 2, y1, x2 + w2 / 2, y2 + h2];
      d = `M ${f0(sx)} ${f0(sy)} L ${f0(ex)} ${f0(y2 > y1 ? ey - 3 : ey + 3)}`;
    }
    const dash = e.dashed ? ' stroke-dasharray="6 4"' : '';
    out.push(
      `<path d="${d}" fill="none" stroke="${MUTED}" stroke-width="1.6"${dash} marker-end="url(#arr)"/>`
    );
    if (e.label) {
      const lx = (sx + ex) / 2;
      const ly = (sy + ey) / 2 - 6;
      out.push(
        `<text x="${f0(lx)}" y="${f0(ly)}" font-size="11" font-style="italic" ` +
          `fill="${BLUE}" text-anchor="middle">${escapeHtml(e.label)}</text>`
      );
    }
  }

  // Блоки
  for (const node of g.nodes) {
    const [x, y, w, h] = pos.get(node.id) as [number, number, number, number];
    const dash = node.dashed ? ' stroke-dasharray="6 4"' : '';
    out.push(
      `<rect x="${f0(x)}" y="${f0(y)}" width="${f0(w)}" height="${f0(h)}" rx="10" ` +
        `fill="white" stroke="${BLUE}" stroke-width="1.6"${dash}/>`
    );
    let ty = y + PAD + FONT;
    if (node.role) {
      let role = node.role.toUpperCase();
      const chars = Array.from(role);
      if (chars.length > 34) role = `${chars.slice(0, 33).join('')}…`;
      out.push(
        `<text x="${f0(x + w / 2)}" y="${f0(y - 7)}" font-size="11" font-weight="600" ` +
          `fill="${BLUE}" text-anchor="middle">${escapeHtml(role)}</text>`
      );
    }
    for (const line of wrap(node.text)) {
      out.push(
        `<text x="${f0(x + w / 2)}" y="${f0(ty)}" font-size="${FONT}" fill="${INK}" ` +
          `text-anchor="middle">${escapeHtml(line)}</text>`
      );
      ty += LINE_H;
    }
  }
  out.push('</svg>');
  return out.join('');
}
