import 'server-only';

// Разбиение документа на чанки. Порт services/rag/chunker.py:
// иерархический сплиттер с авто-выбором стратегии по структуре текста —
// нормативный акт (чанк = статья), структурированный ЛНА (чанк с путём-
// заголовком) или обычный текст (жадная склейка абзацев/предложений).
//
// Метаданные чанка (article_no / unit_*) попадают в payload Qdrant и нужны
// навигации «статья 81», «раздел 3», «последний пункт» и блоку «Источники».

// В Python `\b` и `\w` знают кириллицу, в JS — только ASCII (см. lib/ml/pipeline.ts).
const W = '0-9A-Za-zА-Яа-яЁё_';
const B = `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`;

function ru(pattern: string, flags = ''): RegExp {
  return new RegExp(pattern.replace(/\\b/g, B).replace(/\\w/g, `[${W}]`), flags);
}

/** settings.chunk_size = 600 — размер чанка в символах. */
export const CHUNK_SIZE = Math.max(1, Number(process.env.CHUNK_SIZE || 600));
/** settings.chunk_overlap = 100 — «хвост» предыдущего чанка. */
export const CHUNK_OVERLAP = Math.max(0, Number(process.env.CHUNK_OVERLAP || 100));

const PARAGRAPH_SPLIT = /\n\s*\n+/;
const SENT_SPLIT = /(?<=[.!?…])\s+(?=[А-ЯA-ZЁ0-9])/;

// Маркер начала статьи нормативного акта: «Статья 5.», «Статья 22.», «Статья 84.1»
const ARTICLE_HEAD = /^[\s]*Статья\s+\d+(?:\.\d+)?\.?/gim;

export interface Chunk {
  text: string;
  index: number;
  char_start: number;
  char_end: number;
  // Метаданные нормативных актов («Статья N») — для навигации по статьям.
  article_no: number | null;
  is_article_head: boolean;
  // Обобщённая структурная единица для НЕ-кодексных документов:
  // раздел/глава/пункт/параграф. unit_no — канонический номер-строка («3», «3.2»),
  // unit_ord — float для сортировки, is_unit_head — заголовок единицы.
  unit_type: string | null; // section | chapter | clause | paragraph
  unit_no: string | null;
  unit_ord: number | null;
  is_unit_head: boolean;
}

function chunk(text: string, index: number, charStart: number, charEnd: number, rest: Partial<Chunk> = {}): Chunk {
  return {
    text,
    index,
    char_start: charStart,
    char_end: charEnd,
    article_no: null,
    is_article_head: false,
    unit_type: null,
    unit_no: null,
    unit_ord: null,
    is_unit_head: false,
    ...rest,
  };
}

// Номер статьи из начала чанка: «Статья 81.», «статья 84.1», а также из
// маркера-продолжения «[Статья 81. … — продолжение] …».
const ARTICLE_NO_RE = ru('^\\s*\\[?\\s*стать\\w*\\s+(\\d+(?:\\.\\d+)?)', 'i');

/**
 * Номер статьи (число, чтобы «84.1» сравнивалось корректно) или null.
 * Порт parse_article_no. Такая же копия живёт в lib/ml/retriever.ts — в Python
 * функция тоже одна на chunker и retriever, но импорт оттуда сюда потянул бы
 * загрузку модели эмбеддингов в индексатор.
 */
export function parseArticleNo(text: string): number | null {
  const m = ARTICLE_NO_RE.exec(text || '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Эвристика: >= 5 заголовков статей — считаем документ нормативным актом. */
function looksLikeLegalAct(text: string): boolean {
  ARTICLE_HEAD.lastIndex = 0;
  return [...(text || '').matchAll(ARTICLE_HEAD)].length >= 5;
}

// ── Нормативные акты ───────────────────────────────────────────────────────

/**
 * Структурный сплиттер для нормативных актов: каждый чанк — это одна статья
 * (или её часть), всегда начинается с маркера «Статья N. …».
 */
function splitLegalText(text: string, chunkSize: number, overlap: number): Chunk[] {
  ARTICLE_HEAD.lastIndex = 0;
  const matches = [...text.matchAll(ARTICLE_HEAD)];
  if (!matches.length) return splitText(text, chunkSize, overlap);

  const chunks: Chunk[] = [];
  const add = (t: string, start: number, end: number, isHead = false) => {
    const clean = t.trim();
    if (!clean) return;
    chunks.push(
      chunk(clean, chunks.length, start, end, {
        article_no: parseArticleNo(clean),
        is_article_head: isHead,
      })
    );
  };

  // Префикс до первой статьи (преамбула, главы и т.п.) — отдельным чанком
  const firstStart = matches[0].index ?? 0;
  if (firstStart > 0) {
    const preface = text.slice(0, firstStart);
    if (preface.trim()) add(preface, 0, firstStart);
  }

  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const block = text.slice(start, end).trim();
    if (!block) return;

    // Заголовок статьи (первая строка целиком)
    const firstNl = block.indexOf('\n');
    const head = (firstNl > 0 ? block.slice(0, firstNl) : block).trim().slice(0, 160);

    if (block.length <= chunkSize) {
      add(block, start, end, true);
      return;
    }

    // Длинная статья — режем простым жадным сплиттером (без структурного режима,
    // чтобы нумерованные пункты внутри статьи не подменили маркер «продолжение»).
    const sub = splitPlain(block, chunkSize, overlap);
    sub.forEach((s, j) => {
      if (j === 0) add(s.text, start + s.char_start, start + s.char_end, true);
      else add(`[${head} — продолжение] ${s.text}`, start + s.char_start, start + s.char_end);
    });
  });

  return chunks;
}

// ── Структурные документы НЕ нормативного типа ─────────────────────────────
// Инструкции, положения, регламенты, ЛНА часто структурированы заголовками
// «Раздел/Глава/§» и нумерацией «1.», «2.3», но без «Статья N». Для них мы тоже
// хотим осмысленные границы чанков и КОНТЕКСТ заголовка в каждом чанке —
// «[Раздел 3. Оплата труда › 3.2 Сроки выплаты] …».

const HEADING_KEYWORD_RE = ru('^(раздел|глава|подраздел|часть|параграф|§|приложение)\\b', 'i');
// Нумерованный заголовок: «1. …», «2.3 …», «3.1.2 …» (короткая строка-титул).
const HEADING_NUM_RE = /^(\d+(?:\.\d+)*)([.)])?\s+(\S)/;

function isLower(c: string): boolean {
  return /\p{Ll}/u.test(c);
}

function isUpper(c: string): boolean {
  return /\p{Lu}|\p{Lt}/u.test(c);
}

function isAlpha(c: string): boolean {
  return /\p{L}/u.test(c);
}

function isDigit(c: string): boolean {
  return /\p{Nd}/u.test(c);
}

/** str.split() без аргументов. */
function words(s: string): string[] {
  return s.split(/\s+/).filter((x) => x !== '');
}

/** str.strip(chars). */
function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a += 1;
  while (b > a && chars.includes(s[b - 1])) b -= 1;
  return s.slice(a, b);
}

/**
 * Номер нумерованного заголовка («3.2») или null. Два фильтра ложных
 * срабатываний: одиночному числу обязателен разделитель («2. Название» —
 * заголовок, «2 смена:» — нет), а после номера должна идти НЕ строчная буква
 * («2.\tобъявление недоверия…» — элемент перечисления).
 */
function numberedHeading(s: string): string | null {
  const m = HEADING_NUM_RE.exec(s);
  if (!m) return null;
  // Необязательная группа может не совпасть — типизируем как в рантайме.
  const [, num, sep, first] = m as unknown as (string | undefined)[];
  if (num === undefined || first === undefined) return null;
  if (!num.includes('.') && sep === undefined) return null;
  if (isLower(first)) return null;
  return num;
}

/** Уровень заголовка (1 — верхний) или null, если строка не похожа на заголовок. */
function headingLevel(line: string): number | null {
  const s = line.trim();
  if (!s || s.length > 120) return null;
  if (HEADING_KEYWORD_RE.test(s)) {
    const low = s.toLowerCase();
    if (low.startsWith('раздел') || low.startsWith('часть') || low.startsWith('приложение')) return 1;
    if (low.startsWith('глава')) return 2;
    return 3; // подраздел / параграф / §
  }
  if (s.length <= 100) {
    const num = numberedHeading(s);
    if (num !== null) return (num.match(/\./g) || []).length + 1; // глубина нумерации
  }
  // Строка, начинающаяся с числа, но не признанная нумерованным заголовком
  // («2 смена:», «2. перечисление…»), — не заголовок; КАПС-эвристику к ней
  // не применяем, иначе «2 СМЕНА:» станет разделом.
  if (isDigit(s[0])) return null;
  // Короткий заголовок КАПСОМ («ОБЩИЕ ПОЛОЖЕНИЯ»)
  const letters = Array.from(s).filter(isAlpha);
  if (letters.length >= 4 && words(s).length >= 2 && s.length <= 80) {
    if (letters.filter(isUpper).length / letters.length >= 0.8) return 1;
  }
  return null;
}

function countHeadings(text: string): number {
  return (text || '').split('\n').filter((ln) => headingLevel(ln) !== null).length;
}

// ── Разбор структурной единицы из заголовка (для навигации) ────────────────

const ROMAN_RE = /^[IVXLCDM]+$/i;
const DOTTED_NUM_RE = /^\d+(?:\.\d+)*$/;
// Ключевое слово заголовка → тип единицы.
const UNIT_KEYWORDS: [string, string][] = [
  ['подраздел', 'section'],
  ['раздел', 'section'],
  ['часть', 'section'],
  ['глава', 'chapter'],
  ['параграф', 'paragraph'],
  ['§', 'paragraph'],
];

function romanToInt(s: string): number | null {
  const vals: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  let prev = 0;
  for (const ch of Array.from(s.toUpperCase()).reverse()) {
    const v = vals[ch] ?? 0;
    if (v === 0) return null;
    total += v < prev ? -v : v;
    prev = Math.max(prev, v);
  }
  return total || null;
}

/** «3.»→['3',3.0]; «3.2»→['3.2',3.002]; «II»→['2',2.0]. */
function canonAndOrd(token: string): [string | null, number | null] {
  const t = stripChars(token.trim(), '.').trim();
  if (!t) return [null, null];
  if (DOTTED_NUM_RE.test(t)) {
    const comps = t.split('.').map((x) => Number.parseInt(x, 10));
    const ordv = comps.reduce((acc, c, i) => acc + c / 1000 ** i, 0);
    return [comps.join('.'), ordv];
  }
  if (ROMAN_RE.test(t)) {
    const n = romanToInt(t);
    return n ? [String(n), n] : [null, null];
  }
  return [null, null];
}

/** Заголовок → [unit_type, unit_no, unit_ord]. null, если номер не распознан. */
function parseUnit(heading: string | null): [string | null, string | null, number | null] {
  if (!heading) return [null, null, null];
  const s = heading.trim();
  const low = s.toLowerCase();
  for (const [kw, typ] of UNIT_KEYWORDS) {
    if (!low.startsWith(kw)) continue;
    const rest = stripChars(s.slice(kw.length), ' .№N\t');
    const token = words(rest)[0] ?? '';
    const [no, ordv] = canonAndOrd(token);
    return no ? [typ, no, ordv] : [null, null, null];
  }
  // Единые с headingLevel правила: ложные «заголовки» (перечисления, строки
  // таблиц) не должны получать unit-метаданные.
  const num = numberedHeading(s);
  if (num !== null) {
    const [no, ordv] = canonAndOrd(num);
    return no ? ['clause', no, ordv] : [null, null, null];
  }
  return [null, null, null];
}

// ── Нарезка ────────────────────────────────────────────────────────────────

type Unit = [string, number, number];

/** Разбивает текст на единицы (параграф или предложение) с char-офсетами. */
function paragraphUnits(text: string, chunkSize: number): Unit[] {
  const units: Unit[] = [];
  let cursor = 0;
  for (const para of text.split(PARAGRAPH_SPLIT)) {
    const paraClean = para.trim();
    if (!paraClean) {
      cursor = text.indexOf('\n\n', cursor);
      if (cursor === -1) break;
      cursor += 2;
      continue;
    }
    let start = text.indexOf(paraClean, cursor);
    if (start === -1) start = cursor;
    const end = start + paraClean.length;
    cursor = end;
    if (paraClean.length <= chunkSize) {
      units.push([paraClean, start, end]);
    } else {
      let subCursor = start;
      for (const sent of paraClean.split(SENT_SPLIT)) {
        const clean = sent.trim();
        if (!clean) continue;
        let sStart = text.indexOf(clean, subCursor);
        if (sStart === -1) sStart = subCursor;
        const sEnd = sStart + clean.length;
        subCursor = sEnd;
        units.push([clean, sStart, sEnd]);
      }
    }
  }
  return units;
}

/** Жадно склеивает единицы до chunkSize с overlap из хвоста предыдущего. */
function pack(units: Unit[], chunkSize: number, overlap: number): Unit[] {
  const packed: Unit[] = [];
  let bufText = '';
  let bufStart = 0;
  let bufEnd = 0;

  for (const [unitText, uStart, uEnd] of units) {
    if (!bufText) {
      bufText = unitText;
      bufStart = uStart;
      bufEnd = uEnd;
      continue;
    }
    const candidate = `${bufText}\n${unitText}`;
    if (candidate.length <= chunkSize) {
      bufText = candidate;
      bufEnd = uEnd;
    } else {
      packed.push([bufText.trim(), bufStart, bufEnd]);
      if (overlap > 0) {
        const last = packed[packed.length - 1];
        bufText = `${last[0].slice(-overlap)}\n${unitText}`;
        bufStart = Math.max(0, last[2] - overlap);
      } else {
        bufText = unitText;
        bufStart = uStart;
      }
      bufEnd = uEnd;
    }
  }
  if (bufText.trim()) packed.push([bufText.trim(), bufStart, bufEnd]);
  return packed;
}

function splitPlain(text: string, chunkSize: number, overlap: number): Chunk[] {
  return pack(paragraphUnits(text, chunkSize), chunkSize, overlap).map(([t, st, en], i) =>
    chunk(t, i, st, en)
  );
}

/**
 * Сплиттер по заголовкам: накапливает иерархию, префиксует чанк «путём» в
 * структуре и проставляет unit-метаданные (тип/номер ближайшего заголовка).
 */
function splitStructuredText(text: string, chunkSize: number, overlap: number): Chunk[] {
  let stack = new Map<number, string>();
  const blocks: [string, string | null, string][] = []; // (path, heading, body)
  let curPath = '';
  let curHead: string | null = null;
  let curBody: string[] = [];

  const flush = () => {
    const body = curBody.join('\n').trim();
    if (body || curHead) blocks.push([curPath, curHead, body]);
  };

  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (!s) {
      curBody.push('');
      continue;
    }
    const lvl = headingLevel(s);
    if (lvl !== null) {
      flush();
      stack = new Map([...stack].filter(([k]) => k < lvl));
      stack.set(lvl, s);
      curPath = [...stack.keys()]
        .sort((a, b) => a - b)
        .map((k) => stack.get(k) as string)
        .join(' › ');
      curHead = s;
      curBody = [];
    } else {
      curBody.push(s);
    }
  }
  flush();

  const chunks: Chunk[] = [];
  for (const [blockPath, heading, body] of blocks) {
    const [utype, uno, uord] = parseUnit(heading);
    if (!body) {
      // Навигируемый head-чанк из одного заголовка (раздел без прямого текста).
      chunks.push(
        chunk(blockPath ? `[${blockPath}]` : heading || '', chunks.length, 0, 0, {
          unit_type: utype,
          unit_no: uno,
          unit_ord: uord,
          is_unit_head: Boolean(utype),
        })
      );
      continue;
    }
    const pieces = pack(paragraphUnits(body, chunkSize), chunkSize, overlap);
    pieces.forEach(([piece], j) => {
      chunks.push(
        chunk(blockPath ? `[${blockPath}]\n${piece}` : piece, chunks.length, 0, 0, {
          unit_type: utype,
          unit_no: uno,
          unit_ord: uord,
          is_unit_head: j === 0 && Boolean(utype),
        })
      );
    });
  }

  return chunks.length ? chunks : splitPlain(text, chunkSize, overlap);
}

/**
 * Иерархический сплиттер с авто-выбором стратегии по структуре документа:
 * - нормативный акт (≥5 «Статья N») → чанк = статья (+ article_no);
 * - структурированный (заголовки «Раздел/Глава/N.N») → чанк с контекстом-путём;
 * - прочее → жадная склейка параграфов/предложений.
 */
export function splitText(
  text: string,
  chunkSize: number | null = null,
  overlap: number | null = null
): Chunk[] {
  const size = chunkSize || CHUNK_SIZE;
  const ov = overlap || CHUNK_OVERLAP;

  const clean = (text || '').trim();
  if (!clean) return [];

  if (looksLikeLegalAct(clean)) return splitLegalText(clean, size, ov);
  if (countHeadings(clean) >= 3) return splitStructuredText(clean, size, ov);
  return splitPlain(clean, size, ov);
}
