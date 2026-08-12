import 'server-only';
import PizZip from 'pizzip';
import { escapeXml } from './docx';

/**
 * Минимальный конструктор .xlsx со стилями — подмножество openpyxl, нужное
 * описи уволенных (dismissed_inventory.py) и отчёту по дубликатам ОТ
 * (ot_dedup.py).
 *
 * Почему не SheetJS: в открытой версии `xlsx` запись стилей ячеек не
 * поддерживается (только чтение), а в описи важны рамки, жирная шапка,
 * объединённые ячейки и заливка «дубликатов». Поэтому пакет собирается вручную.
 */

export interface CellStyle {
  bold?: boolean;
  /** Кегль в пунктах (Font(size=…)). */
  size?: number;
  align?: 'center' | 'left' | 'right';
  vAlign?: 'center' | 'top' | 'bottom';
  wrap?: boolean;
  /** Тонкая рамка по всем сторонам (Border(Side('thin')) ×4). */
  border?: boolean;
  /** Сплошная заливка, RGB без альфы: 'FDE8E8'. */
  fill?: string;
}

export interface XlsxCell {
  /** 1-based, как в openpyxl. */
  row: number;
  col: number;
  value: string | number;
  style?: CellStyle;
}

export interface XlsxSheet {
  name: string;
  cells: XlsxCell[];
  merges?: { r1: number; c1: number; r2: number; c2: number }[];
  /** Ширина колонки в «символах» (ws.column_dimensions[…].width). */
  cols?: { col: number; width: number }[];
  /** Высота строки в пунктах (ws.row_dimensions[…].height). */
  rows?: { row: number; height: number }[];
}

/** 1 → A, 27 → AA (аналог openpyxl.utils.get_column_letter). */
export function colLetter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const THIN =
  '<left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>' +
  '<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/>';

/** Реестр стилей: одинаковые CellStyle получают один индекс в cellXfs. */
class StyleTable {
  private fonts = new Map<string, number>();
  private fontXml: string[] = [];
  private fills = new Map<string, number>();
  private fillXml: string[] = [];
  private borders = new Map<string, number>();
  private borderXml: string[] = [];
  private xfs = new Map<string, number>();
  private xfXml: string[] = [];

  constructor() {
    // Индексы 0 у шрифта/рамки и 0–1 у заливки зарезервированы форматом:
    // Excel считает файл повреждённым, если fills[0] != none, fills[1] != gray125.
    this.font('<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>');
    this.fill('<fill><patternFill patternType="none"/></fill>');
    this.fill('<fill><patternFill patternType="gray125"/></fill>');
    this.border('<border><left/><right/><top/><bottom/><diagonal/></border>');
    this.xf('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  }

  private intern(map: Map<string, number>, list: string[], xml: string): number {
    const found = map.get(xml);
    if (found !== undefined) return found;
    const idx = list.length;
    map.set(xml, idx);
    list.push(xml);
    return idx;
  }

  private font(xml: string) {
    return this.intern(this.fonts, this.fontXml, xml);
  }
  private fill(xml: string) {
    return this.intern(this.fills, this.fillXml, xml);
  }
  private border(xml: string) {
    return this.intern(this.borders, this.borderXml, xml);
  }
  private xf(xml: string) {
    return this.intern(this.xfs, this.xfXml, xml);
  }

  /** Индекс cellXfs для стиля ячейки. */
  index(style?: CellStyle): number {
    if (!style) return 0;
    const fontId = this.font(
      `<font>${style.bold ? '<b/>' : ''}<sz val="${style.size ?? 11}"/><name val="Calibri"/><family val="2"/></font>`
    );
    const fillId = style.fill
      ? this.fill(
          `<fill><patternFill patternType="solid"><fgColor rgb="FF${style.fill}"/><bgColor indexed="64"/></patternFill></fill>`
        )
      : 0;
    const borderId = style.border ? this.border(`<border>${THIN}</border>`) : 0;

    const alignAttrs: string[] = [];
    if (style.align) alignAttrs.push(`horizontal="${style.align}"`);
    if (style.vAlign) alignAttrs.push(`vertical="${style.vAlign}"`);
    if (style.wrap) alignAttrs.push('wrapText="1"');
    const alignment = alignAttrs.length ? `<alignment ${alignAttrs.join(' ')}/>` : '';

    const flags =
      `${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}` +
      `${borderId ? ' applyBorder="1"' : ''}${alignment ? ' applyAlignment="1"' : ''}`;
    return this.xf(
      `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${flags}>` +
        `${alignment}</xf>`
    );
  }

  xml(): string {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<fonts count="${this.fontXml.length}">${this.fontXml.join('')}</fonts>` +
      `<fills count="${this.fillXml.length}">${this.fillXml.join('')}</fills>` +
      `<borders count="${this.borderXml.length}">${this.borderXml.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfXml.length}">${this.xfXml.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

function sheetXml(sheet: XlsxSheet, styles: StyleTable): string {
  // Ячейки по строкам: openpyxl пишет их в порядке возрастания координат.
  const byRow = new Map<number, XlsxCell[]>();
  for (const c of sheet.cells) {
    const list = byRow.get(c.row);
    if (list) list.push(c);
    else byRow.set(c.row, [c]);
  }
  const heights = new Map((sheet.rows || []).map((r) => [r.row, r.height] as const));

  const rowNums = [...new Set([...byRow.keys(), ...heights.keys()])].sort((a, b) => a - b);
  const rowsXml = rowNums
    .map((rn) => {
      const cells = (byRow.get(rn) || []).slice().sort((a, b) => a.col - b.col);
      const inner = cells
        .map((c) => {
          const ref = `${colLetter(c.col)}${c.row}`;
          const s = styles.index(c.style);
          const sAttr = s ? ` s="${s}"` : '';
          if (typeof c.value === 'number') {
            return `<c r="${ref}"${sAttr}><v>${c.value}</v></c>`;
          }
          // Инлайновые строки вместо sharedStrings — читаются всеми клиентами
          // и не требуют отдельной части пакета.
          return c.value === ''
            ? `<c r="${ref}"${sAttr}/>`
            : `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(c.value)}</t></is></c>`;
        })
        .join('');
      const h = heights.get(rn);
      const hAttr = h !== undefined ? ` ht="${h}" customHeight="1"` : '';
      return `<row r="${rn}"${hAttr}>${inner}</row>`;
    })
    .join('');

  const colsXml = sheet.cols?.length
    ? '<cols>' +
      sheet.cols
        .map((c) => `<col min="${c.col}" max="${c.col}" width="${c.width}" customWidth="1"/>`)
        .join('') +
      '</cols>'
    : '';
  const mergesXml = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">` +
      sheet.merges
        .map(
          (m) =>
            `<mergeCell ref="${colLetter(m.c1)}${m.r1}:${colLetter(m.c2)}${m.r2}"/>`
        )
        .join('') +
      '</mergeCells>'
    : '';

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `${colsXml}<sheetData>${rowsXml}</sheetData>${mergesXml}</worksheet>`
  );
}

/** Собирает .xlsx из листов. Возвращает содержимое файла. */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const styles = new StyleTable();
  const sheetParts = sheets.map((s) => sheetXml(s, styles));

  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets
        .map(
          (s, i) =>
            `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
        )
        .join('') +
      '</sheets></workbook>'
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
        )
        .join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>'
  );
  sheetParts.forEach((xml, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, xml));
  // styles.xml собираем последним: индексы стилей набираются при рендере листов.
  zip.file('xl/styles.xml', styles.xml());

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
