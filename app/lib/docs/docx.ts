import 'server-only';
import PizZip from 'pizzip';

/**
 * Минимальный конструктор .docx — подмножество python-docx, которым пользуются
 * генераторы документов (characteristic.py, dpo_report.py, vacancy.py,
 * employee_certificate.py, pps_announcement.py).
 *
 * Почему свой, а не docxtemplater: тот умеет только ПОДСТАВЛЯТЬ значения в
 * готовый .docx, а здесь документ собирается с нуля (шаблона нет).
 *
 * Воспроизводится ровно то, что использует Python: стиль Normal (Times New
 * Roman 12 pt), абзацы с выравниванием/отступами/интервалом, прогоны с
 * жирностью/курсивом/подчёркиванием/кеглем, табуляция.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

// Стиль Normal: `doc.styles["Normal"].font` = Times New Roman 12 pt — во всех
// генераторах Python выставляется именно так.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>`;

// Размер страницы — Letter с полями 1", как в шаблоне по умолчанию python-docx
// (default.docx). Меняя на A4, мы разошлись бы с документами, которые сейчас
// отдаёт FastAPI.
const SECT_PR =
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
  '</w:sectPr>';

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface DocxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Кегль в пунктах (Pt) — как run.font.size. */
  sizePt?: number;
}

export interface DocxPara {
  runs?: DocxRun[];
  align?: 'center' | 'justify';
  /** paragraph_format.first_line_indent, Pt. */
  firstLineIndentPt?: number;
  /** paragraph_format.left_indent, Pt. */
  leftIndentPt?: number;
  /** paragraph_format.space_after, Pt. */
  spaceAfterPt?: number;
  /** tab_stops.add_tab_stop(Pt(x)) — позиции табуляции. */
  tabStopsPt?: number[];
}

/** Pt → twips (1 pt = 20 twip); python-docx хранит отступы именно так. */
const tw = (pt: number) => Math.round(pt * 20);

/**
 * Текст прогона в OOXML. Порт сеттера Run.text: '\t' → <w:tab/>,
 * '\n' и '\r' → <w:br/>, остальное — <w:t>.
 */
function runContent(text: string): string {
  let out = '';
  let buf = '';
  const flush = () => {
    if (buf) {
      out += `<w:t xml:space="preserve">${escapeXml(buf)}</w:t>`;
      buf = '';
    }
  };
  for (const ch of text) {
    if (ch === '\t') {
      flush();
      out += '<w:tab/>';
    } else if (ch === '\n' || ch === '\r') {
      flush();
      out += '<w:br/>';
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

function runXml(r: DocxRun): string {
  // Порядок элементов внутри w:rPr задан схемой CT_RPr: b, i, sz, u.
  let rPr = '';
  if (r.bold) rPr += '<w:b/>';
  if (r.italic) rPr += '<w:i/>';
  if (r.sizePt) rPr += `<w:sz w:val="${Math.round(r.sizePt * 2)}"/><w:szCs w:val="${Math.round(r.sizePt * 2)}"/>`;
  if (r.underline) rPr += '<w:u w:val="single"/>';
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${runContent(r.text)}</w:r>`;
}

function paraXml(p: DocxPara): string {
  // Порядок в CT_PPr: tabs → spacing → ind → jc.
  let pPr = '';
  if (p.tabStopsPt?.length) {
    const tabs = p.tabStopsPt.map((pt) => `<w:tab w:val="left" w:pos="${tw(pt)}"/>`).join('');
    pPr += `<w:tabs>${tabs}</w:tabs>`;
  }
  if (p.spaceAfterPt !== undefined) pPr += `<w:spacing w:after="${tw(p.spaceAfterPt)}"/>`;
  const ind: string[] = [];
  if (p.leftIndentPt !== undefined) ind.push(`w:left="${tw(p.leftIndentPt)}"`);
  if (p.firstLineIndentPt !== undefined) ind.push(`w:firstLine="${tw(p.firstLineIndentPt)}"`);
  if (ind.length) pPr += `<w:ind ${ind.join(' ')}/>`;
  if (p.align) pPr += `<w:jc w:val="${p.align === 'center' ? 'center' : 'both'}"/>`;

  const runs = (p.runs || []).map(runXml).join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}

/** Собирает .docx из абзацев. Возвращает содержимое файла. */
export function buildDocx(paras: DocxPara[]): Buffer {
  const body = paras.map(paraXml).join('');
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}${SECT_PR}</w:body></w:document>`;

  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', document);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

/** Абзац с единственным прогоном — аналог doc.add_paragraph(text). */
export function p(text: string, opts: Omit<DocxPara, 'runs'> = {}): DocxPara {
  return { runs: text ? [{ text }] : [], ...opts };
}

/** Пустой абзац — doc.add_paragraph(). */
export const emptyPara: () => DocxPara = () => ({ runs: [] });
