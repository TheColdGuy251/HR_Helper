/**
 * Whitelist-санитайзер HTML из rich-редактора новостей.
 * Порт backend/utils/htmlsanitize.py.
 *
 * Оригинал разбирает фрагмент через lxml; тянуть новую npm-зависимость нельзя,
 * поэтому здесь собственный потоковый разбор тегов. Списки разрешённых тегов,
 * атрибутов, классов и правила проверки URL скопированы один в один — меняется
 * только «починка» разметки: lxml перестраивает дерево целиком, мы же лишь
 * закрываем незакрытые теги и игнорируем лишние закрывающие.
 */

// Разрешённые CSS-классы: наши (news-*) и FontAwesome (fa/fas/far/fab, fa-*).
const CLASS_RE = /^(news-[a-z0-9-]+|fa[bslr]?|fa-[a-z0-9-]+)$/;

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'a', 'img',
  'span', 'div', 'pre', 'code', 'figure', 'figcaption',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
};

const NO_ATTRS: Set<string> = new Set();

// Числовые атрибуты — оставляем только если это целое число.
const NUMERIC_ATTRS = new Set(['width', 'height']);

// Теги, которые вырезаем вместе с содержимым (не просто разворачиваем).
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
  'button', 'textarea', 'select', 'link', 'meta', 'svg', 'math', 'noscript',
]);

// Пустые элементы HTML: закрывающего тега не имеют, содержимого тоже.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Элементы с сырым текстом: внутри них «<» не начинает тег, поэтому содержимое
// вычитываем до закрывающего тега, не разбирая (иначе `var a = "<b>"` в скрипте
// развалит разбор).
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

// ── экранирование ──────────────────────────────────────────────────────────
// Амперсанд экранируем только если он не начинает существующую сущность:
// редактор вставляет &nbsp;, и превращать их в &amp;nbsp; нельзя.

const BARE_AMP_RE = /&(?![a-zA-Z][a-zA-Z0-9]{0,31};|#\d{1,7};|#[xX][0-9a-fA-F]{1,6};)/g;

function escapeAmp(s: string): string {
  return s.replace(BARE_AMP_RE, '&amp;');
}

function escapeText(s: string): string {
  return escapeAmp(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeAmp(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(160),
  tab: '\t',
  newline: '\n',
  sol: '/',
  colon: ':',
  lpar: '(',
  rpar: ')',
};

/**
 * Раскодировать сущности. Нужно только для ПРОВЕРОК: lxml отдавал правилам уже
 * раскодированное значение, поэтому без этого href="&#106;avascript:…"
 * проскочил бы мимо чёрного списка схем, а браузер бы его выполнил.
 */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Убирает управляющие символы: браузер выкидывает их при разборе URL. */
function stripControls(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code > 31 && code !== 127) out += ch;
  }
  return out;
}

function safeUrl(value: string, tag: string): boolean {
  const v = value.trim();
  if (!v) return false;
  // Схему проверяем на строке без управляющих символов — иначе «java&#9;script:»
  // пройдёт проверку, а браузер всё равно выполнит.
  const probe = stripControls(v);
  const low = probe.toLowerCase();
  if (
    low.startsWith('javascript:') || low.startsWith('data:') ||
    low.startsWith('vbscript:') || low.startsWith('file:')
  ) {
    return false;
  }
  if (tag === 'img') {
    // Картинки — только наши загруженные (через /api/news/media/…).
    return probe.startsWith('/api/news/media/');
  }
  // Ссылки: относительные, якоря, http(s), mailto, tel.
  if (probe.startsWith('/') || probe.startsWith('#')) return true;
  return (
    low.startsWith('http://') || low.startsWith('https://') ||
    low.startsWith('mailto:') || low.startsWith('tel:')
  );
}

// ── разбор ─────────────────────────────────────────────────────────────────

interface Attr {
  name: string;
  value: string | null;
}

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'comment' } // комментарии, doctype, processing-instructions
  | { kind: 'open'; name: string; attrs: Attr[] }
  | { kind: 'close'; name: string };

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/** Ищет начало закрывающего тега сырого элемента (script/style/…). */
function findRawClose(html: string, from: number, name: string): number {
  const needle = `</${name}`;
  const lower = html.toLowerCase();
  let idx = lower.indexOf(needle, from);
  while (idx !== -1) {
    const after = html[idx + needle.length];
    if (after === undefined || isSpace(after) || after === '>' || after === '/') return idx;
    idx = lower.indexOf(needle, idx + 1);
  }
  return html.length;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const n = html.length;
  let i = 0;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      tokens.push({ kind: 'text', value: html.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ kind: 'text', value: html.slice(i, lt) });
    i = lt;

    const next = html[lt + 1];
    if (next === undefined) {
      tokens.push({ kind: 'text', value: '<' });
      break;
    }

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      tokens.push({ kind: 'comment' });
      continue;
    }
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      tokens.push({ kind: 'comment' });
      continue;
    }
    if (next === '/') {
      if (!isAlpha(html[lt + 2] ?? '')) {
        // «</ …>» — мусорный комментарий по правилам HTML, выбрасываем.
        const end = html.indexOf('>', lt);
        i = end === -1 ? n : end + 1;
        tokens.push({ kind: 'comment' });
        continue;
      }
      let j = lt + 2;
      while (j < n && !isSpace(html[j]) && html[j] !== '>' && html[j] !== '/') j++;
      const name = html.slice(lt + 2, j).toLowerCase();
      const end = html.indexOf('>', j);
      i = end === -1 ? n : end + 1;
      tokens.push({ kind: 'close', name });
      continue;
    }
    if (!isAlpha(next)) {
      // «<» сам по себе — обычный текст.
      tokens.push({ kind: 'text', value: '<' });
      i = lt + 1;
      continue;
    }

    // Открывающий тег: имя.
    let j = lt + 1;
    while (j < n && !isSpace(html[j]) && html[j] !== '>' && html[j] !== '/') j++;
    const name = html.slice(lt + 1, j).toLowerCase();

    // Атрибуты. «/» между атрибутами по правилам HTML игнорируется, поэтому
    // трюк <img/src=…/onerror=…> разбирается как обычные атрибуты.
    const attrs: Attr[] = [];
    while (j < n) {
      while (j < n && (isSpace(html[j]) || html[j] === '/')) j++;
      if (j >= n) break;
      if (html[j] === '>') {
        j++;
        break;
      }
      const nameStart = j;
      while (j < n && !isSpace(html[j]) && html[j] !== '=' && html[j] !== '>' && html[j] !== '/') j++;
      const attrName = html.slice(nameStart, j);
      if (!attrName) {
        j++; // страховка от зацикливания на неожиданном символе
        continue;
      }
      let value: string | null = null;
      let k = j;
      while (k < n && isSpace(html[k])) k++;
      if (html[k] === '=') {
        k++;
        while (k < n && isSpace(html[k])) k++;
        const q = html[k];
        if (q === '"' || q === "'") {
          const endQuote = html.indexOf(q, k + 1);
          value = endQuote === -1 ? html.slice(k + 1) : html.slice(k + 1, endQuote);
          j = endQuote === -1 ? n : endQuote + 1;
        } else {
          const valStart = k;
          while (k < n && !isSpace(html[k]) && html[k] !== '>') k++;
          value = html.slice(valStart, k);
          j = k;
        }
      }
      attrs.push({ name: attrName.toLowerCase(), value });
    }
    i = j;
    tokens.push({ kind: 'open', name, attrs });

    if (RAW_TEXT_TAGS.has(name)) {
      const close = findRawClose(html, i, name);
      if (close > i) tokens.push({ kind: 'text', value: html.slice(i, close) });
      i = close;
    }
  }

  return tokens;
}

/** Индекс токена сразу за закрывающим тегом элемента (содержимое пропускаем). */
function skipElement(tokens: Token[], start: number, name: string): number {
  let depth = 1;
  let i = start;
  while (i < tokens.length) {
    const tk = tokens[i++];
    if (tk.kind === 'open' && tk.name === name && !VOID_TAGS.has(name)) depth++;
    else if (tk.kind === 'close' && tk.name === name && --depth === 0) return i;
  }
  return tokens.length;
}

function filterAttrs(tag: string, attrs: Attr[]): Attr[] {
  const allowed = ALLOWED_ATTRS[tag] ?? NO_ATTRS;
  const out: Attr[] = [];
  const seen = new Set<string>();

  for (const a of attrs) {
    const n = a.name;
    if (seen.has(n)) continue; // дубликаты: как и парсер, берём первый
    seen.add(n);
    const raw = a.value ?? '';

    // class разрешён на любом теге, но только из белого списка имён.
    if (n === 'class') {
      const toks = decodeEntities(raw).split(/\s+/).filter((c) => CLASS_RE.test(c));
      if (toks.length) out.push({ name: 'class', value: toks.join(' ') });
      continue;
    }
    if (n.startsWith('on') || !allowed.has(n)) continue;
    if (n === 'href' || n === 'src') {
      if (!safeUrl(decodeEntities(raw), tag)) continue;
    } else if (NUMERIC_ATTRS.has(n) && !/^\d+$/.test(decodeEntities(raw).trim())) {
      continue;
    }
    out.push({ name: n, value: raw });
  }
  return out;
}

function setAttr(attrs: Attr[], name: string, value: string): void {
  const existing = attrs.find((a) => a.name === name);
  if (existing) existing.value = value;
  else attrs.push({ name, value });
}

function renderOpen(tag: string, attrs: Attr[]): string {
  let s = `<${tag}`;
  for (const a of attrs) s += ` ${a.name}="${escapeAttr(a.value ?? '')}"`;
  return `${s}>`;
}

/**
 * Возвращает безопасный HTML-фрагмент. Неизвестные теги разворачиваются
 * (текст сохраняется), опасные — удаляются целиком, атрибуты фильтруются.
 */
export function sanitizeHtml(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const tokens = tokenize(raw);
  const out: string[] = [];
  const stack: string[] = [];
  // lxml-овский parent.remove(el) уносит и «хвост» — текст сразу за удалённым
  // элементом. Повторяем, чтобы результат совпадал с питоновским.
  let dropTail = false;
  let i = 0;

  const closeUpTo = (name: string) => {
    const idx = stack.lastIndexOf(name);
    if (idx === -1) return;
    while (stack.length > idx) out.push(`</${stack.pop()}>`);
  };

  while (i < tokens.length) {
    const tk = tokens[i++];
    const skipText = dropTail;
    dropTail = false;

    if (tk.kind === 'text') {
      if (!skipText) out.push(escapeText(tk.value));
      continue;
    }
    if (tk.kind === 'comment') {
      dropTail = true;
      continue;
    }
    if (tk.kind === 'close') {
      if (ALLOWED_TAGS.has(tk.name)) closeUpTo(tk.name);
      continue;
    }

    const t = tk.name;
    if (DROP_WITH_CONTENT.has(t)) {
      if (!VOID_TAGS.has(t)) i = skipElement(tokens, i, t);
      dropTail = true;
      continue;
    }
    if (!ALLOWED_TAGS.has(t)) continue; // неизвестный тег — снимаем, текст оставляем

    const attrs = filterAttrs(t, tk.attrs);
    if (t === 'a') {
      if (!attrs.some((a) => a.name === 'href')) continue; // ссылка без адреса — просто текст
      setAttr(attrs, 'rel', 'noopener noreferrer');
      setAttr(attrs, 'target', '_blank');
    }
    if (t === 'img' && !attrs.some((a) => a.name === 'src')) {
      dropTail = true;
      continue;
    }

    out.push(renderOpen(t, attrs));
    if (!VOID_TAGS.has(t)) stack.push(t);
  }

  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('').trim();
}
