import 'server-only';
import type { ParsedFile } from '@/lib/parsers';

/**
 * Извлечение основного текста веб-страницы.
 * Порт backend/services/parsers/web.py (fetch_url, _clean_text, _extract_title,
 * parse_url).
 *
 * ПОЧЕМУ БЕЗ НОВЫХ ЗАВИСИМОСТЕЙ. В проекте уже есть прецедент: lib/htmlsanitize.ts
 * разбирает HTML собственным потоковым парсером именно чтобы не тянуть
 * зависимость. Аналог trafilatura в Node — @mozilla/readability, но он требует
 * полноценный DOM (linkedom), то есть ДВЕ новые зависимости ради одного
 * эндпоинта. Поэтому здесь эвристики поверх того же потокового разбора тегов.
 *
 * ОТЛИЧИЯ ОТ PYTHON:
 *  - вместо trafilatura — выбор блока с максимальной «плотностью текста»
 *    (текст/разметка) с приоритетом <article>/<main>, фолбэк — <body>.
 *    Текст получается близким, но не байт-в-байт: у trafilatura своя эвристика
 *    и свои правила дедупликации абзацев;
 *  - автор берётся из <meta name="author"> (trafilatura смотрит ещё JSON-LD,
 *    микроразметку и OpenGraph), поэтому чаще выходит null;
 *  - _clean_text и _extract_title (<title> → <h1> → url) портированы дословно.
 */

// Описательный бот-UA — запасной для сайтов, которые ТРЕБУЮТ идентификации робота
// и блокируют браузерные UA (Wikimedia и др., «robot policy»). Основной UA —
// браузерный (settings.web_user_agent), т.к. большинство сайтов, наоборот, блокируют ботов.
const BOT_USER_AGENT = 'HRHelperBot/1.0 (+https://www.tyuiu.ru; contact: hr-helper@tyuiu.ru)';
/** settings.web_user_agent из backend/config.py. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BLOCK_CODES = new Set([401, 403, 406, 429]);
/** settings.web_request_timeout (секунды) */
const REQUEST_TIMEOUT_MS = 30_000;

// ── Загрузка ───────────────────────────────────────────────────────────────

/** Текст исключения httpx.HTTPStatusError — он попадает в detail ответа 500. */
function statusError(status: number, statusText: string, url: string): Error {
  const kind = status < 500 ? 'Client error' : 'Server error';
  return new Error(
    `${kind} '${status} ${statusText}' for url '${url}'\n` +
      `For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${status}`
  );
}

/**
 * Кодировка тела: Content-Type → <meta charset> → UTF-8. Node всегда декодирует
 * response.text() как UTF-8, а российские сайты нередко отдают windows-1251 —
 * без этого шага текст превращается в «кракозябры». httpx делает то же самое.
 */
function decodeBody(buf: Buffer, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  // Первые 2 КБ достаточно: <meta charset> обязан стоять в начале <head>.
  const head = buf.subarray(0, 2048).toString('latin1');
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  const charset = (fromHeader || fromMeta || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * Скачивает страницу и возвращает декодированный HTML. Пробует браузерный UA;
 * при блокировке (403/406/429/…) повторяет с описательным бот-UA.
 */
export async function fetchUrl(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
  const agents = [BROWSER_USER_AGENT, BOT_USER_AGENT];
  let lastError: Error | null = null;

  for (let i = 0; i < agents.length; i += 1) {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': agents[i],
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) {
      return decodeBody(Buffer.from(await resp.arrayBuffer()), resp.headers.get('content-type') || '');
    }
    // Тело ответа нужно прочитать, иначе соединение останется висеть в пуле.
    await resp.arrayBuffer().catch(() => undefined);
    lastError = statusError(resp.status, resp.statusText, resp.url || url);
    if (!(BLOCK_CODES.has(resp.status) && i + 1 < agents.length)) throw lastError;
  }

  throw lastError ?? new Error('fetch_url: недостижимо');
}

// ── Разбор HTML ────────────────────────────────────────────────────────────

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Вырезаются ВМЕСТЕ с содержимым — тот же список, что у _bs4_extract.
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'svg',
]);

// Границы абзацев при сборке текста (get_text("\n") в bs4 ставит их между всеми
// узлами, но так рвутся предложения на инлайновых <b>/<a> — оставляем блочные).
const BLOCK_TAGS = new Set([
  'address', 'article', 'blockquote', 'caption', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tbody',
  'tfoot', 'thead', 'tr', 'ul',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', bdquo: '„',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  deg: '°', copy: '©', reg: '®', trade: '™', euro: '€', rarr: '→', larr: '←',
  shy: '', zwj: '', zwnj: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

function unescapeHtml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : full;
    }
    return NAMED_ENTITIES[code] ?? full;
  });
}

/** Убирает комментарии и служебные блоки вместе с содержимым. */
function stripNoise(html: string): string {
  const clean = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const parts: string[] = [];
  let last = 0;
  let dropped: string | null = null;
  let depth = 0;

  TAG_RE.lastIndex = 0;
  for (const m of clean.matchAll(TAG_RE)) {
    const name = m[2].toLowerCase();
    const closing = m[1] === '/';
    const selfClosing = m[4] === '/' || VOID_TAGS.has(name);

    if (dropped) {
      if (name !== dropped) continue;
      if (closing) {
        depth -= 1;
        if (depth === 0) {
          dropped = null;
          last = (m.index ?? 0) + m[0].length;
        }
      } else if (!selfClosing) {
        depth += 1;
      }
      continue;
    }
    if (!closing && !selfClosing && DROP_TAGS.has(name)) {
      parts.push(clean.slice(last, m.index));
      dropped = name;
      depth = 1;
    }
  }
  parts.push(clean.slice(last));
  return parts.join('');
}

/** Видимый текст фрагмента: блочные теги → перевод строки, ячейки → « | ». */
function htmlToText(html: string): string {
  const out: string[] = [];
  let last = 0;

  TAG_RE.lastIndex = 0;
  for (const m of html.matchAll(TAG_RE)) {
    out.push(unescapeHtml(html.slice(last, m.index)));
    last = (m.index ?? 0) + m[0].length;
    const name = m[2].toLowerCase();
    if (name === 'br' || name === 'tr') out.push('\n');
    else if (name === 'td' || name === 'th') out.push(m[1] === '/' ? ' | ' : '');
    else if (BLOCK_TAGS.has(name)) out.push('\n');
  }
  out.push(unescapeHtml(html.slice(last)));

  // Пробелы внутри строки схлопываем (в разметке перевод строки — просто пробел),
  // сами переводы строк сохраняем как границы абзацев.
  return out
    .join('')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n');
}

interface Block {
  tag: string;
  html: string;
}

/**
 * Элементы-кандидаты на «основной блок». Стек допускает незакрытые теги:
 * закрывающий тег снимает всё, что открылось после него.
 */
function candidateBlocks(html: string): Block[] {
  const CANDIDATE_TAGS = new Set(['article', 'main', 'section', 'div', 'td', 'body']);
  const stack: { name: string; innerStart: number }[] = [];
  const blocks: Block[] = [];

  TAG_RE.lastIndex = 0;
  for (const m of html.matchAll(TAG_RE)) {
    const name = m[2].toLowerCase();
    const start = m.index ?? 0;
    if (m[4] === '/' || VOID_TAGS.has(name)) continue;

    if (m[1] !== '/') {
      stack.push({ name, innerStart: start + m[0].length });
      continue;
    }
    let at = stack.length - 1;
    while (at >= 0 && stack[at].name !== name) at -= 1;
    if (at < 0) continue;
    for (let i = stack.length - 1; i >= at; i -= 1) {
      const open = stack[i];
      // Закрывающий тег принадлежит только «своему» элементу; вложенные
      // незакрытые обрезаем по этой же позиции.
      if (CANDIDATE_TAGS.has(open.name)) {
        blocks.push({ tag: open.name, html: html.slice(open.innerStart, start) });
      }
    }
    stack.length = at;
  }
  // Незакрытый <body> — тянем до конца документа.
  for (const open of stack) {
    if (CANDIDATE_TAGS.has(open.name)) {
      blocks.push({ tag: open.name, html: html.slice(open.innerStart) });
    }
  }
  return blocks;
}

/**
 * Основной текст страницы: блок с максимальной «плотностью текста»
 * (доля полезного текста в разметке) при приоритете <article>/<main>.
 * Квадрат длины в числителе не даёт выиграть короткому плотному блоку
 * вроде хлебных крошек.
 */
function extractMain(html: string): string {
  const blocks = candidateBlocks(html);
  let best = '';
  let bestScore = 0;
  let bestPriority = -1;

  for (const b of blocks) {
    if (b.html.length < 200) continue;
    const priority = b.tag === 'article' || b.tag === 'main' ? 1 : 0;
    if (priority < bestPriority) continue;
    const text = htmlToText(b.html).trim();
    if (text.length < 100) continue;
    const score = (text.length * text.length) / b.html.length;
    if (priority > bestPriority || score > bestScore) {
      best = text;
      bestScore = score;
      bestPriority = priority;
    }
  }
  return best;
}

/** Весь <body> (или документ целиком) — грубый запасной разбор. */
function extractBody(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return htmlToText(body ? body[1] : html).trim();
}

// ── Чистка текста (порт _clean_text) ───────────────────────────────────────

// Навигация «предыдущая/следующая статья», хлебные крошки в виде таблицы —
// типичный шум правовых/справочных баз. Убираем строки, где ОДНОВРЕМЕННО есть
// разделитель таблицы «|» и стрелки перехода «<<»/«>>» — обычная проза так не выглядит.
const NAV_ROW_RE = /\|.*(?:<<|>>)|(?:<<|>>).*\|/;
const PIPE_ONLY_RE = /^[\s|]+$/;
const MULTI_BLANK_RE = /\n{3,}/g;

/** Убирает навигационные артефакты и лишние пустые строки, не трогая содержимое. */
export function cleanText(text: string): string {
  if (!text) return '';
  const out: string[] = [];
  for (const ln of text.split(/\r\n|\r|\n/)) {
    const s = ln.trim();
    if (!s) {
      out.push('');
      continue;
    }
    if (PIPE_ONLY_RE.test(s)) continue;
    if (NAV_ROW_RE.test(s)) continue;
    out.push(ln.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(MULTI_BLANK_RE, '\n\n').trim();
}

// ── Заголовок и метаданные ─────────────────────────────────────────────────

/** Заголовок: <title> → <h1> → fallback (url). Порт _extract_title. */
function extractTitle(html: string, fallback: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  // BeautifulSoup: .string непустой, только если внутри <title> нет других тегов.
  if (title && !/</.test(title[1])) {
    const t = unescapeHtml(title[1]).trim();
    if (t) return t;
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) {
    // get_text(strip=True): текст узлов без разделителя, с обрезкой пробелов.
    const t = htmlToText(h1[1]).split('\n').map((s) => s.trim()).join('').trim();
    if (t) return t;
  }
  return fallback;
}

function extractAuthor(html: string): string | null {
  const m = /<meta[^>]+name=["']author["'][^>]+content=["']([^"']*)["']/i.exec(html);
  const author = m ? unescapeHtml(m[1]).trim() : '';
  return author || null;
}

// ── Публичный вход ─────────────────────────────────────────────────────────

/** Страница по URL → текст и метаданные документа. Порт parse_url. */
export async function parseUrl(url: string): Promise<ParsedFile> {
  const html = stripNoise(await fetchUrl(url));

  let text = cleanText(extractMain(html));
  if (text.length < 40) {
    // Основной блок не нашёлся (SPA/нетипичная разметка) — берём весь <body>.
    const fallback = cleanText(extractBody(html));
    if (fallback.length > text.length) text = fallback;
  }

  const title = extractTitle(html, url);

  return {
    text: text.trim(),
    meta: {
      title: title || url,
      source_uri: url,
      source_type: 'web',
      mime_type: 'text/html',
      pages: 0,
      extra: { author: extractAuthor(html) },
    },
  };
}
