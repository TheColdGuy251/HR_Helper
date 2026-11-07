import 'server-only';
import PizZip from 'pizzip';

/**
 * Минимальный конструктор .docx для генераторов документов (характеристика,
 * отчёт по ДПО, вакансия, справка на работника, объявление ППС).
 *
 * Почему свой, а не docxtemplater: тот умеет только подставлять значения в
 * готовый .docx, а здесь документ собирается с нуля (шаблона нет).
 *
 * Поддерживается: стиль Normal (Times New Roman 12 pt), абзацы с
 * выравниванием/отступами/интервалом, прогоны с жирностью/курсивом/
 * подчёркиванием/кеглем, табуляция.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

// Стиль Normal: Times New Roman 12 pt - во всех генераторах.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>`;

// Размер страницы - Letter с полями 1".
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

/** Встроенная картинка: содержимое + размер отображения в пунктах. */
export interface DocxImage {
  data: Buffer;
  ext: 'png' | 'jpeg';
  widthPt: number;
  heightPt: number;
}

export interface DocxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Кегль в пунктах (Pt) - как run.font.size. */
  sizePt?: number;
  /** Картинка вместо текста (text при этом игнорируется). */
  image?: DocxImage;
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
  /** tab_stops.add_tab_stop(Pt(x)) - позиции табуляции. */
  tabStopsPt?: number[];
  /**
   * Плавающая рамка (w:framePr): абзац фиксированного размера, текст
   * следующих абзацев обтекает её. Используется под фото в справке.
   */
  frame?: { widthPt: number; heightPt: number; border?: boolean };
}

/** Pt -> twips (1 pt = 20 twip). */
const tw = (pt: number) => Math.round(pt * 20);

/** Текст прогона в OOXML. */
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

/** Pt -> EMU (English Metric Units) для DrawingML: 1 pt = 12700 EMU. */
const emu = (pt: number) => Math.round(pt * 12700);

/** Картинки, собранные при рендере: порядковый номер -> медиа-часть. */
interface CollectedImage {
  rId: string;
  ext: 'png' | 'jpeg';
  data: Buffer;
}

/** Встроенная (inline) картинка DrawingML. Word требует уникальный docPr id. */
function imageXml(img: DocxImage, rId: string, n: number): string {
  const cx = emu(img.widthPt);
  const cy = emu(img.heightPt);
  return (
    '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${n}" name="image${n}"/>` +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
  );
}

function runXml(r: DocxRun, images: CollectedImage[]): string {
  if (r.image) {
    const n = images.length + 1;
    const rId = `rIdImg${n}`;
    images.push({ rId, ext: r.image.ext, data: r.image.data });
    return `<w:r>${imageXml(r.image, rId, n)}</w:r>`;
  }
  // Порядок элементов внутри w:rPr задан схемой CT_RPr: b, i, sz, u.
  let rPr = '';
  if (r.bold) rPr += '<w:b/>';
  if (r.italic) rPr += '<w:i/>';
  if (r.sizePt) rPr += `<w:sz w:val="${Math.round(r.sizePt * 2)}"/><w:szCs w:val="${Math.round(r.sizePt * 2)}"/>`;
  if (r.underline) rPr += '<w:u w:val="single"/>';
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${runContent(r.text)}</w:r>`;
}

function paraXml(p: DocxPara, images: CollectedImage[]): string {
  // Порядок в CT_PPr: framePr -> pBdr -> tabs -> spacing -> ind -> jc.
  let pPr = '';
  if (p.frame) {
    pPr +=
      `<w:framePr w:w="${tw(p.frame.widthPt)}" w:h="${tw(p.frame.heightPt)}" w:hRule="exact"` +
      ' w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:x="0" w:y="0"/>';
  }
  if (p.frame?.border) {
    const side = '<w:top w:val="single" w:sz="4" w:space="4" w:color="808080"/>';
    pPr += `<w:pBdr>${side}${side.replace('w:top', 'w:left')}${side.replace('w:top', 'w:bottom')}${side.replace('w:top', 'w:right')}</w:pBdr>`;
  }
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

  const runs = (p.runs || []).map((r) => runXml(r, images)).join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}

/** Собирает .docx из абзацев. Возвращает содержимое файла. */
export function buildDocx(paras: DocxPara[]): Buffer {
  const images: CollectedImage[] = [];
  const body = paras.map((p) => paraXml(p, images)).join('');
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}${SECT_PR}</w:body></w:document>`;

  // Медиа-части и content-types добавляются только при наличии картинок:
  // документы без них остаются байт-в-байт прежними.
  let contentTypes = CONTENT_TYPES;
  let docRels = DOC_RELS;
  const zip = new PizZip();
  if (images.length) {
    const defaults = new Set(images.map((i) => i.ext));
    const extra = [...defaults]
      .map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`)
      .join('');
    contentTypes = contentTypes.replace('<Override', `${extra}<Override`);
    const rels = images
      .map(
        (img, i) =>
          `<Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.${img.ext}"/>`
      )
      .join('');
    docRels = docRels.replace('</Relationships>', `${rels}</Relationships>`);
    images.forEach((img, i) => zip.file(`word/media/image${i + 1}.${img.ext}`, img.data));
  }
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', document);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/_rels/document.xml.rels', docRels);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

/** Абзац с единственным прогоном - аналог doc.add_paragraph(text). */
export function p(text: string, opts: Omit<DocxPara, 'runs'> = {}): DocxPara {
  return { runs: text ? [{ text }] : [], ...opts };
}

/** Пустой абзац - doc.add_paragraph(). */
export const emptyPara: () => DocxPara = () => ({ runs: [] });
