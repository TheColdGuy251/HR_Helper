import 'server-only';
import PizZip from 'pizzip';

/**
 * Чтение .docx на уровне OOXML — ровно те возможности python-docx, на которые
 * опирается перенесённый код: текст абзацев/ячеек, объединения ячеек таблиц,
 * подчёркнутые прогоны и рамки абзацев.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В lib/parsers: там разбор docx идёт через mammoth (HTML →
 * абзацы и таблицы) и годится для полнотекстового индекса, но теряет и
 * объединения ячеек (на них держится группировка FAQ), и форматирование
 * прогонов (на нём держится авто-разметка полей бланка). Модуль делят между
 * собой два эндпоинта базы знаний — app/api/kb/faq/import и app/api/kb/templates.
 *
 * ОТЛИЧИЯ ОТ python-docx:
 *  - paragraph.text включает текст внутри <w:hyperlink> (так делает python-docx
 *    1.2; в 1.1 гиперссылки терялись), а paragraph.runs — только прямые <w:r>;
 *  - поля (<w:fldSimple>, инструкции полей) и вставки редактора (<w:ins>) не
 *    разворачиваются: у python-docx их тоже нет в run-ах абзаца;
 *  - имена элементов сравниваются с префиксом «w:» буквально (python-docx
 *    разрешает namespace через nsmap). Word и LibreOffice пишут именно этот
 *    префикс, но экзотический генератор .docx может его переименовать.
 */

// ── Мини-DOM ───────────────────────────────────────────────────────────────

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export function isElement(node: XmlNode): node is XmlElement {
  return typeof node !== 'string';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : full;
    }
    return ENTITIES[code] ?? full;
  });
}

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Конец тега с учётом кавычек: «>» внутри значения атрибута тег не закрывает. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  for (let i = from; i < xml.length; i += 1) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return xml.length;
}

/**
 * Разбор XML в дерево. Достаточно для OOXML: пролог, комментарии и CDATA
 * пропускаются, незакрытые теги закрываются по концу документа.
 */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].children.push(unescapeXml(xml.slice(i, lt)));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      stack[stack.length - 1].children.push(xml.slice(lt + 9, end < 0 ? xml.length : end));
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      i = xml.indexOf('>', lt) + 1 || xml.length;
      continue;
    }

    const gt = tagEnd(xml, lt + 1);
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;

    if (raw[0] === '/') {
      const name = raw.slice(1).trim();
      let at = stack.length - 1;
      while (at > 0 && stack[at].name !== name) at -= 1;
      if (at > 0) stack.length = at;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = body.search(/[\s/]/);
    const name = nameEnd < 0 ? body : body.slice(0, nameEnd);
    const attrs: Record<string, string> = {};
    if (nameEnd >= 0) {
      ATTR_RE.lastIndex = 0;
      for (const a of body.slice(nameEnd).matchAll(ATTR_RE)) {
        attrs[a[1]] = unescapeXml(a[2] ?? a[3] ?? '');
      }
    }
    const el: XmlElement = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
  }

  return root;
}

/** Прямые дочерние элементы (при указанном имени — только они). */
export function childElements(parent: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of parent.children) {
    if (isElement(c) && (name === undefined || c.name === name)) out.push(c);
  }
  return out;
}

/** Первый прямой потомок с таким именем. */
export function childElement(parent: XmlElement, name: string): XmlElement | null {
  for (const c of parent.children) if (isElement(c) && c.name === name) return c;
  return null;
}

/** Первый потомок с таким именем на любой глубине. */
export function findElement(parent: XmlElement, name: string): XmlElement | null {
  for (const c of parent.children) {
    if (!isElement(c)) continue;
    if (c.name === name) return c;
    const deep = findElement(c, name);
    if (deep) return deep;
  }
  return null;
}

// ── Документ ───────────────────────────────────────────────────────────────

/** Тело документа (<w:body>) из .docx. Бросает исключение на не-docx. */
export function loadDocxBody(data: Buffer): XmlElement {
  const zip = new PizZip(data);
  const part = zip.files['word/document.xml'];
  if (!part) throw new Error('word/document.xml отсутствует — это не .docx');
  const body = findElement(parseXml(part.asText()), 'w:body');
  if (!body) throw new Error('в word/document.xml нет w:body');
  return body;
}

// ── Абзацы и прогоны ───────────────────────────────────────────────────────

/** Текст прогона: <w:t> как есть, <w:tab> → \t, <w:br>/<w:cr> → перевод строки. */
export function runText(run: XmlElement): string {
  let text = '';
  for (const c of run.children) {
    if (!isElement(c)) continue;
    if (c.name === 'w:t') text += c.children.filter((x) => !isElement(x)).join('');
    else if (c.name === 'w:tab') text += '\t';
    else if (c.name === 'w:br' || c.name === 'w:cr') text += '\n';
  }
  return text;
}

/** Прогоны абзаца — только прямые <w:r> (как paragraph.runs у python-docx). */
export function runs(paragraph: XmlElement): XmlElement[] {
  return childElements(paragraph, 'w:r');
}

/** Текст абзаца: прогоны и содержимое гиперссылок в порядке следования. */
export function paragraphText(paragraph: XmlElement): string {
  let text = '';
  for (const c of paragraph.children) {
    if (!isElement(c)) continue;
    if (c.name === 'w:r') text += runText(c);
    else if (c.name === 'w:hyperlink') for (const r of childElements(c, 'w:r')) text += runText(r);
  }
  return text;
}

/** Подчёркнут ли прогон (run.underline): <w:u> с любым val, кроме «none». */
export function runUnderlined(run: XmlElement): boolean {
  const rPr = childElement(run, 'w:rPr');
  const u = rPr ? childElement(rPr, 'w:u') : null;
  if (!u) return false;
  const val = u.attrs['w:val'] ?? 'single';
  return val !== 'none' && val !== '0' && val !== 'false';
}

/** Рамка абзаца сверху или снизу (_para_has_border из autofill.py). */
export function paragraphHasBorder(paragraph: XmlElement): boolean {
  const pPr = childElement(paragraph, 'w:pPr');
  if (!pPr) return false;
  const bdr = childElement(pPr, 'w:pBdr');
  if (!bdr) return false;
  return Boolean(childElement(bdr, 'w:top') || childElement(bdr, 'w:bottom'));
}

// ── Таблицы ────────────────────────────────────────────────────────────────

/** Число столбцов сетки (table.columns / CT_Tbl.col_count). */
export function columnCount(table: XmlElement): number {
  const grid = childElement(table, 'w:tblGrid');
  return grid ? childElements(grid, 'w:gridCol').length : 0;
}

/** Число строк (table.rows). */
export function rowCount(table: XmlElement): number {
  return childElements(table, 'w:tr').length;
}

/** Текст ячейки: абзацы через перевод строки (_Cell.text). */
export function cellText(tc: XmlElement): string {
  return childElements(tc, 'w:p').map(paragraphText).join('\n');
}

function gridSpan(tc: XmlElement): number {
  const tcPr = childElement(tc, 'w:tcPr');
  const span = tcPr ? childElement(tcPr, 'w:gridSpan') : null;
  const n = span ? Number.parseInt(span.attrs['w:val'] ?? '1', 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** null — вертикального объединения нет; «continue» — продолжение ячейки сверху. */
function vMergeVal(tc: XmlElement): string | null {
  const tcPr = childElement(tc, 'w:tcPr');
  const merge = tcPr ? childElement(tcPr, 'w:vMerge') : null;
  // Атрибут необязателен, значение по умолчанию — «continue».
  return merge ? (merge.attrs['w:val'] ?? 'continue') : null;
}

/**
 * Текст ячеек таблицы построчно — с семантикой python-docx `row.cells`:
 * у объединённых ячеек текст ПОВТОРЯЕТСЯ в каждой клетке сетки (по горизонтали
 * из-за gridSpan, по вертикали — из-за vMerge), потому что это один и тот же
 * объект ячейки. На этом держится группировка строк FAQ (_group_rows).
 */
export function tableRows(table: XmlElement): string[][] {
  const cols = columnCount(table);
  const trs = childElements(table, 'w:tr');
  if (cols <= 0) return trs.map((tr) => childElements(tr, 'w:tc').map(cellText));

  // Плоский список клеток сетки — ровно как Table._cells в python-docx.
  const flat: string[] = [];
  for (const tr of trs) {
    for (const tc of childElements(tr, 'w:tc')) {
      const span = gridSpan(tc);
      const merge = vMergeVal(tc);
      for (let k = 0; k < span; k += 1) {
        if (merge === 'continue') flat.push(flat[flat.length - cols] ?? '');
        else if (k === 0) flat.push(cellText(tc));
        else flat.push(flat[flat.length - 1] ?? '');
      }
    }
  }
  // Строки нарезаются по числу столбцов сетки — как row_cells(row_idx).
  return trs.map((_, i) => flat.slice(i * cols, (i + 1) * cols));
}

/** Таблицы верхнего уровня (doc.tables: вложенные в ячейки сюда не попадают). */
export function bodyTables(body: XmlElement): XmlElement[] {
  return childElements(body, 'w:tbl');
}

/** Абзацы верхнего уровня (doc.paragraphs: без абзацев внутри таблиц). */
export function bodyParagraphs(body: XmlElement): XmlElement[] {
  return childElements(body, 'w:p');
}

/** Абзацы любой вложенности — нужны для поиска {{переменных}} в таблицах. */
export function allParagraphs(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of childElements(el)) {
    if (child.name === 'w:p') out.push(child);
    else out.push(...allParagraphs(child));
  }
  return out;
}
