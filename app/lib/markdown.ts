import 'server-only';

/**
 * Минимальный безопасный markdown → HTML для страницы просмотра документов.
 * Порт backend/utils/markdown.py (md_to_html) — построчно, включая порядок
 * инлайновых замен: от него зависит, что получится из вложенной разметки.
 *
 * Почему не переиспользуется formatMessageContent из lib/msgfmt.ts: тот —
 * порт static/js/message_format.js для ОТВЕТОВ БОТА (перенумерация цитат,
 * блок «Источники», карточки документов, свои CSS-классы). Здесь нужен другой
 * контракт: чистый HTML без служебной разметки чата, ровно тот, что уже сейчас
 * отдаёт Python для режимов markdown и web-документов.
 */

/** html.escape(s, quote=True) — апостроф Python кодирует как &#x27;, не &#39;. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** _inline: строка УЖЕ экранирована, применяем инлайновые преобразования. */
function inline(s: string): string {
  let out = s.replace(/`([^`]+?)`/g, '<code>$1</code>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  return out;
}

/** Преобразует markdown в HTML. Достаточно для предпросмотра ЛНА/инструкций. */
export function mdToHtml(text: string | null | undefined): string {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + para.map((x) => inline(escapeHtml(x))).join('<br>') + '</p>');
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Блоки кода ```
    if (line.trim().startsWith('```')) {
      if (!inCode) {
        flushPara();
        inCode = true;
        codeBuf = [];
      } else {
        out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
        inCode = false;
      }
      i += 1;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i += 1;
      continue;
    }

    const stripped = line.trim();
    const h = /^(#{1,6})\s+(.+)$/.exec(stripped);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(escapeHtml(h[2]))}</h${lvl}>`);
      i += 1;
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(stripped)) {
      flushPara();
      out.push('<hr>');
      i += 1;
      continue;
    }
    // Списки: маркированный и нумерованный собираются в ОДИН блок — тег
    // выбирается по первой строке, как в Python.
    if (/^[-*+]\s+/.test(stripped) || /^\d+[.)]\s+/.test(stripped)) {
      flushPara();
      const ordered = /^\d+[.)]\s+/.test(stripped);
      const items: string[] = [];
      while (i < lines.length) {
        const st = lines[i].trim();
        const m = /^[-*+]\s+(.*)$/.exec(st) || /^\d+[.)]\s+(.*)$/.exec(st);
        if (!m) break;
        items.push(inline(escapeHtml(m[1])));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((x) => `<li>${x}</li>`).join('') + `</${tag}>`);
      continue;
    }
    if (stripped === '') {
      flushPara();
      i += 1;
      continue;
    }
    para.push(stripped);
    i += 1;
  }

  // Незакрытый ``` — код всё равно отдаём (иначе потеряли бы хвост документа).
  if (inCode) out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
  flushPara();
  return out.join('\n');
}
