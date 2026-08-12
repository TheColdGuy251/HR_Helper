import 'server-only';

/**
 * Крошечный XML-DOM с ТОЧНЫМ обратным выводом — нужен для правки
 * `word/document.xml` в бланках (см. autofill.ts).
 *
 * Почему не готовая библиотека: в зависимостях парсера XML нет, а требование
 * здесь необычное — всё, что мы не трогаем, обязано вернуться в файл байт в
 * байт (иначе поедет форматирование бланка). Поэтому атрибуты и текстовые
 * узлы хранятся исходными строками, а разбираются только на чтение.
 */

export interface XElement {
  kind: 'el';
  tag: string;
  /** Исходная строка атрибутов вместе с ведущим пробелом — выводится как есть. */
  attrsRaw: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Элемент записан как <tag/>. */
  empty: boolean;
}

/** Текст, комментарий, CDATA, инструкция обработки — переносится дословно. */
export interface XRaw {
  kind: 'raw';
  text: string;
}

export type XNode = XElement | XRaw;

export function isElement(n: XNode): n is XElement {
  return n.kind === 'el';
}

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(raw); m; m = ATTR_RE.exec(raw)) {
    out[m[1]] = m[2] ?? m[3] ?? '';
  }
  return out;
}

/** Разбирает XML-документ в дерево. Корнем считается первый элемент. */
export function parseXml(source: string): { prologue: XNode[]; root: XElement } {
  const top: XNode[] = [];
  const stack: XElement[] = [];
  const push = (node: XNode) => {
    if (stack.length) stack[stack.length - 1].children.push(node);
    else top.push(node);
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      push({ kind: 'raw', text: source.slice(i) });
      break;
    }
    if (lt > i) push({ kind: 'raw', text: source.slice(i, lt) });

    // Комментарии, CDATA, инструкции и DTD переносим как есть.
    const literal: [string, string][] = [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?', '?>']];
    const hit = literal.find(([open]) => source.startsWith(open, lt));
    if (hit) {
      const end = source.indexOf(hit[1], lt + hit[0].length);
      const stop = end < 0 ? source.length : end + hit[1].length;
      push({ kind: 'raw', text: source.slice(lt, stop) });
      i = stop;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      const stop = end < 0 ? source.length : end + 1;
      push({ kind: 'raw', text: source.slice(lt, stop) });
      i = stop;
      continue;
    }

    // Тег: ищем закрывающую скобку, не считая скобок внутри кавычек.
    let j = lt + 1;
    let quote = '';
    while (j < source.length) {
      const c = source[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j += 1;
    }
    const inner = source.slice(lt + 1, j);
    i = j + 1;

    if (inner.startsWith('/')) {
      if (stack.length) stack.pop();
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s/]/);
    const tag = nameEnd < 0 ? body : body.slice(0, nameEnd);
    const attrsRaw = nameEnd < 0 ? '' : body.slice(nameEnd);
    const el: XElement = {
      kind: 'el',
      tag,
      attrsRaw,
      attrs: parseAttrs(attrsRaw),
      children: [],
      empty: selfClosing,
    };
    push(el);
    if (!selfClosing) stack.push(el);
  }

  const rootIdx = top.findIndex(isElement);
  if (rootIdx < 0) throw new Error('XML без корневого элемента');
  return { prologue: top.slice(0, rootIdx), root: top[rootIdx] as XElement };
}

export function serializeNode(node: XNode): string {
  if (node.kind === 'raw') return node.text;
  if (node.empty && !node.children.length) return `<${node.tag}${node.attrsRaw}/>`;
  return `<${node.tag}${node.attrsRaw}>${node.children.map(serializeNode).join('')}</${node.tag}>`;
}

export function serializeXml(doc: { prologue: XNode[]; root: XElement }): string {
  return doc.prologue.map(serializeNode).join('') + serializeNode(doc.root);
}

// ── помощники обхода ───────────────────────────────────────────────────────

/** Прямые дочерние элементы с данным тегом. */
export function childrenOf(el: XElement, tag: string): XElement[] {
  return el.children.filter((c): c is XElement => isElement(c) && c.tag === tag);
}

/** Первый прямой дочерний элемент с данным тегом (аналог el.find(qn(...))). */
export function child(el: XElement, tag: string): XElement | null {
  return childrenOf(el, tag)[0] ?? null;
}

/** Все потомки с данным тегом на любой глубине. */
export function descendants(el: XElement, tag: string): XElement[] {
  const out: XElement[] = [];
  const walk = (node: XElement) => {
    for (const c of node.children) {
      if (!isElement(c)) continue;
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** Новый элемент. */
export function element(tag: string, attrs: Record<string, string> = {}, children: XNode[] = []): XElement {
  const attrsRaw = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}"`)
    .join('');
  return { kind: 'el', tag, attrsRaw, attrs, children, empty: !children.length };
}

/** Текстовый узел с экранированием. */
export function textNode(value: string): XRaw {
  return {
    kind: 'raw',
    text: value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  };
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/** Развёрнутый текст всех текстовых узлов элемента (без тегов). */
export function innerText(el: XElement): string {
  let out = '';
  for (const c of el.children) {
    if (c.kind === 'raw') out += c.text;
    else out += innerText(c);
  }
  return out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code: string) => {
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
