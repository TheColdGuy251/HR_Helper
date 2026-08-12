// Общий рендер контента ассистента (порт static/js/message_format.js):
// mini-markdown, перенумерация ссылок-цитат, блок «Источники» с карточками
// документов, карточка вложения. Используется чатом (/chat) и мессенджером,
// чтобы ответы ИИ выглядели одинаково. Возвращает HTML-строки — вставлять
// через dangerouslySetInnerHTML внутри контейнера с классом `msg-md`
// (стили — в app/globals.css).

export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const escapeAttr = escapeHtml;

export interface MessageSource {
  type?: string;
  source_type?: string;
  title?: string;
  article?: string;
  uri?: string;
  url?: string;
  document_id?: number | string;
  attachment_id?: number | string;
}

export interface MessageAttachment {
  id: number | string;
  title?: string;
  filename?: string;
}

// ── Мини-иконки (inline SVG вместо Font Awesome) ────────────────────────────

const ICONS: Record<string, string> = {
  file: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  news: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0V9"/><path d="M12 6h6"/><path d="M12 10h6"/><path d="M12 14h6"/><path d="M12 18h6"/></svg>',
  external: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>',
  paperclip: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
};

function sourceFileIcon(): string {
  // Одна универсальная файловая иконка: тип угадывается по расширению только
  // визуально, для SVG-набора достаточно общей.
  return ICONS.file;
}

// ── Перенумерация цитат из ТЕКСТА модели (когда structured sources нет) ─────

function renumberCitations(raw: string): string {
  const text = String(raw || '');
  if (!/\[\d{1,3}\]/.test(text)) return text;

  const lines = text.split('\n');
  let hdr = -1;
  let inlineTail = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#{0,6}\s*источник[а-яё]*\s*[:：]?\s*$/i.test(t)) {
      hdr = i;
      break;
    }
    const inl = t.match(/^#{0,6}\s*источник[а-яё]*\s*[:：]\s*(.+)$/i);
    if (inl) {
      hdr = i;
      inlineTail = inl[1];
      break;
    }
  }
  if (hdr === -1) return text;

  const articleKey = (title: string) => {
    const a = title.match(/стат(?:ья|ьи|ью|ей|ьями|ьях)?\s*№?\s*(\d+(?:\.\d+)?)/i);
    return a ? 'ст' + a[1] : title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 50);
  };
  const entries: { nums: number[]; title: string }[] = [];
  const parseEntry = (s: string) => {
    const nums: number[] = [];
    let m: RegExpExecArray | null;
    const re = /\[(\d{1,3})\]/g;
    while ((m = re.exec(s))) nums.push(parseInt(m[1], 10));
    const title = s
      .replace(/\[\d{1,3}\]/g, '')
      .replace(/^[\s,;.\-*+]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (nums.length || title) entries.push({ nums, title });
  };
  if (inlineTail) inlineTail.split(/\s*;\s*/).forEach(parseEntry);
  for (let i = hdr + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const mm = t.match(/^[-*+]\s+(.*)$/);
    parseEntry(mm ? mm[1] : t);
  }
  if (!entries.length) return text;

  const chunkInfo: Record<number, { title: string; key: string }> = {};
  for (const e of entries) {
    const key = articleKey(e.title);
    for (const n of e.nums) chunkInfo[n] = { title: e.title, key };
  }

  const body = lines.slice(0, hdr).join('\n');
  // Во время стрима блок «Источники» ещё неполон: если не все ссылки текста
  // разрешаются — не трогаем (иначе бейджи мигают до конца стрима).
  const bodyRefs = new Set<number>();
  let br: RegExpExecArray | null;
  const brRe = /\[(\d{1,3})\]/g;
  while ((br = brRe.exec(body))) bodyRefs.add(parseInt(br[1], 10));
  for (const n of bodyRefs) if (!(n in chunkInfo)) return text;

  const keyToNew: Record<string, number> = {};
  const ordered: { num: number; title: string }[] = [];
  let m: RegExpExecArray | null;
  const refRe = /\[(\d{1,3})\]/g;
  while ((m = refRe.exec(body))) {
    const info = chunkInfo[parseInt(m[1], 10)];
    if (!info) continue;
    if (!(info.key in keyToNew)) {
      keyToNew[info.key] = ordered.length + 1;
      ordered.push({ num: ordered.length + 1, title: info.title });
    }
  }
  for (const e of entries) {
    const key = articleKey(e.title);
    if (!(key in keyToNew)) {
      keyToNew[key] = ordered.length + 1;
      ordered.push({ num: ordered.length + 1, title: e.title });
    }
  }
  if (!ordered.length) return text;

  let newBody = body.replace(/\[(\d{1,3})\]/g, (_full, d) => {
    const info = chunkInfo[parseInt(d, 10)];
    if (!info) return '';
    return `[${keyToNew[info.key]}]`;
  });
  newBody = newBody.replace(/(\[(\d+)\])(?:\s*[,;]?\s*\[\2\])+/g, '[$2]');
  newBody = newBody
    .replace(/\s+([,;])/g, '$1')
    .replace(/([(,;])\s*([,;)])/g, '$1$2')
    .replace(/[ \t]{2,}/g, ' ');

  const srcMd = '## Источники\n' + ordered.map((o) => `- [${o.num}] ${o.title}`).join('\n');
  return newBody.replace(/\s+$/, '') + '\n\n' + srcMd;
}

// ── Источники из СТРУКТУРНЫХ данных (result.sources) ────────────────────────

interface OrderedSource {
  num: number;
  src: MessageSource;
  key: string;
}

function buildSourcesFromStructured(
  rawText: string,
  sources: MessageSource[]
): { body: string; entries: OrderedSource[] } {
  const lines = rawText.split('\n');
  let hdr = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{0,6}\s*источник/i.test(lines[i].trim())) {
      hdr = i;
      break;
    }
  }
  const body = (hdr === -1 ? rawText : lines.slice(0, hdr).join('\n')).replace(/\s+$/, '');

  const keyOf = (src: MessageSource) =>
    (src.article || src.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const keyToNew: Record<string, number> = {};
  const ordered: OrderedSource[] = [];
  let m: RegExpExecArray | null;
  const refRe = /\[(\d{1,3})\]/g;
  while ((m = refRe.exec(rawText))) {
    const src = sources[parseInt(m[1], 10) - 1];
    if (!src || src.type === 'system') continue;
    const key = keyOf(src) || '#' + m[1];
    if (!(key in keyToNew)) {
      keyToNew[key] = ordered.length + 1;
      ordered.push({ num: ordered.length + 1, src, key });
    }
  }
  let newBody = body.replace(/\[(\d{1,3})\]/g, (_full, d) => {
    const src = sources[parseInt(d, 10) - 1];
    if (!src || src.type === 'system') return '';
    const key = keyOf(src) || '#' + d;
    return key in keyToNew ? `[${keyToNew[key]}]` : '';
  });
  newBody = newBody
    .replace(/(\[(\d+)\])(?:\s*[,;]?\s*\[\2\])+/g, '[$2]')
    .replace(/\s+([,;])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');

  return { body: newBody, entries: ordered };
}

// ── Карточки документов-источников ──────────────────────────────────────────

function renderSourceDocCard(src: MessageSource): string {
  const title = escapeHtml(src.title || 'Документ');
  if (src.type === 'attachment') {
    return (
      `<div class="chat-attachment chat-attachment-pinned" title="Прикреплён к диалогу">` +
      `<div class="chat-attachment-icon">${ICONS.paperclip}</div>` +
      `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
      `<div class="chat-attachment-name">прикреплён к диалогу</div></div></div>`
    );
  }
  if (src.source_type === 'news' && src.url) {
    return (
      `<a class="chat-attachment" href="${escapeAttr(src.url)}" target="_blank" rel="noopener" title="Открыть новость">` +
      `<div class="chat-attachment-icon">${ICONS.news}</div>` +
      `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
      `<div class="chat-attachment-name">Новости HR</div></div>` +
      `<div class="chat-attachment-action">${ICONS.external}</div></a>`
    );
  }
  if (src.document_id) {
    const id = encodeURIComponent(String(src.document_id));
    const viewUrl = `/kb/documents/${id}/view`;
    const dlUrl = `/api/kb/documents/${id}/download`;
    const filename = (src.uri || '').split(/[\\/]/).pop() || '';
    return (
      `<div class="chat-attachment">` +
      `<a class="chat-attachment-main" href="${escapeAttr(viewUrl)}" target="_blank" rel="noopener" title="Открыть для просмотра">` +
      `<div class="chat-attachment-icon">${sourceFileIcon()}</div>` +
      `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
      (filename ? `<div class="chat-attachment-name">${escapeHtml(filename)}</div>` : '') +
      `</div></a>` +
      `<a class="chat-attachment-action" href="${escapeAttr(dlUrl)}" title="Скачать" aria-label="Скачать">${ICONS.download}</a></div>`
    );
  }
  if (src.uri && /^https?:/i.test(src.uri)) {
    return (
      `<a class="chat-attachment" href="${escapeAttr(src.uri)}" target="_blank" rel="noopener">` +
      `<div class="chat-attachment-icon">${ICONS.globe}</div>` +
      `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
      `<div class="chat-attachment-name">${escapeHtml(src.uri)}</div></div>` +
      `<div class="chat-attachment-action">${ICONS.external}</div></a>`
    );
  }
  return '';
}

export function renderStructuredSources(entries: OrderedSource[]): string {
  if (!entries || !entries.length) return '';
  const refs = entries
    .map((e) => {
      const label = escapeHtml(e.src.article || e.src.title || 'Источник');
      return `<span class="md-ref"><sup class="md-src-ref">${e.num}</sup>${label}</span>`;
    })
    .join('');

  const docMap = new Map<string, MessageSource>();
  for (const e of entries) {
    const src = e.src || {};
    const key = src.document_id
      ? 'd' + src.document_id
      : src.attachment_id
        ? 'a' + src.attachment_id
        : src.uri || src.url || '';
    if (!key || docMap.has(key)) continue;
    docMap.set(key, src);
  }
  const cards = [...docMap.values()].map(renderSourceDocCard).filter(Boolean);
  let docsHtml = '';
  if (cards.length) {
    const collapsible = cards.length > 3;
    const cls = collapsible ? 'md-docs is-collapsible' : 'md-docs';
    const more = collapsible
      ? `<button type="button" class="md-sources-more">Показать все документы (${cards.length})</button>`
      : '';
    docsHtml = `<div class="${cls}">${cards.join('')}${more}</div>`;
  }

  return (
    `<div class="md-sources"><div class="md-sources-title">Источники</div>` +
    `<div class="md-refs">${refs}</div>${docsHtml}</div>`
  );
}

// ── Основной рендер контента сообщения ──────────────────────────────────────

export function formatMessageContent(
  raw: unknown,
  sources?: MessageSource[] | null,
  includeSources = true
): string {
  if (raw === null || typeof raw === 'undefined') return '';
  let s = String(raw);

  s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\r\n/g, '\n');

  // Источники из структурных данных, если есть (надёжнее текста модели);
  // иначе — текстовая перенумерация по блоку «Источники» из ответа.
  let structuredSourcesHtml = '';
  if (Array.isArray(sources) && sources.length) {
    const built = buildSourcesFromStructured(s, sources);
    s = built.body;
    if (includeSources) structuredSourcesHtml = renderStructuredSources(built.entries);
  } else {
    s = renumberCitations(s);
  }

  const codeBlocks: string[] = [];
  s = s.replace(/```([\s\S]*?)```/g, (_m, p1) => {
    const idx = codeBlocks.push(p1) - 1;
    return ` CODEBLOCK${idx} `;
  });
  const inlineCodes: string[] = [];
  s = s.replace(/`([^`\n]+?)`/g, (_m, p1) => {
    const idx = inlineCodes.push(p1) - 1;
    return ` INLINECODE${idx} `;
  });

  s = escapeHtml(s);

  s = s.replace(/ INLINECODE(\d+) /g, (_m, idx) =>
    `<code class="md-inline-code">${escapeHtml(inlineCodes[Number(idx)] || '')}</code>`
  );

  s = s.replace(/\[([^\]]+)\]\(((?:https?:)?\/\/[^)]+)\)/g, (_m, text, url) =>
    `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`
  );

  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<![\w*])\*(?!\*)([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/(?<![\w_])_([^_\n]+?)_(?![\w_])/g, '<em>$1</em>');

  s = s.replace(/(?<![\w(])\[(\d{1,3})\](?!\()/g, '<sup class="md-src-ref">$1</sup>');

  s = s.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');

  const lines = s.split('\n');
  const out: string[] = [];
  let paraBuf: string[] = [];
  let inSources = false;
  let sourcesBuf: string[] = [];

  function flushPara() {
    if (paraBuf.length) {
      const text = paraBuf.join('<br>').replace(/(<br>)+$/g, '');
      if (text.trim()) out.push(`<p>${text}</p>`);
      paraBuf = [];
    }
  }
  function flushSources() {
    if (sourcesBuf.length) {
      const items = sourcesBuf.map((it) => `<li>${it}</li>`).join('');
      const total = sourcesBuf.length;
      const collapsible = total > 3;
      const cls = collapsible ? 'md-sources is-collapsible' : 'md-sources';
      const more = collapsible
        ? `<button type="button" class="md-sources-more">Показать все источники (${total})</button>`
        : '';
      out.push(
        `<div class="${cls}"><div class="md-sources-title">Источники</div>` +
          `<ul>${items}</ul>${more}</div>`
      );
      sourcesBuf = [];
    }
    inSources = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/^\s+|\s+$/g, '');

    const headMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headMatch) {
      flushPara();
      flushSources();
      const level = Math.min(headMatch[1].length, 6);
      const text = headMatch[2];
      if (/^источник/i.test(text)) {
        inSources = true;
        continue;
      }
      out.push(`<h${level}>${text}</h${level}>`);
      continue;
    }

    const inlineSrc = trimmed.match(/^источники\s*[:：]\s*(.+)$/i);
    if (inlineSrc) {
      flushPara();
      flushSources();
      inSources = true;
      const body = inlineSrc[1];
      const parts = body
        .split(/(?=<sup class="md-src-ref">)/)
        .map((x) => x.trim())
        .filter(Boolean);
      for (const part of parts) sourcesBuf.push(part);
      flushSources();
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushPara();
      flushSources();
      out.push('<hr>');
      continue;
    }

    if (inSources) {
      const m = trimmed.match(/^[-*+]\s+(.*)$/);
      if (m) {
        sourcesBuf.push(m[1]);
        continue;
      }
      if (trimmed === '') {
        flushSources();
        continue;
      }
      sourcesBuf.push(trimmed);
      continue;
    }

    const bq = trimmed.match(/^&gt;\s?(.*)$/);
    if (bq) {
      flushPara();
      const bqLines = [bq[1]];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const nextTrim = lines[j].replace(/^\s+|\s+$/g, '');
        const bqn = nextTrim.match(/^&gt;\s?(.*)$/);
        if (!bqn) break;
        bqLines.push(bqn[1]);
      }
      out.push(`<blockquote>${bqLines.join('<br>')}</blockquote>`);
      i = j - 1;
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ulMatch) {
      flushPara();
      const items = [ulMatch[1]];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const nextTrim = lines[j].replace(/^\s+|\s+$/g, '');
        const m = nextTrim.match(/^[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
      }
      const isTaskList = items.every((it) => /^\[[ xX]\]\s*/.test(it));
      if (isTaskList) {
        out.push(
          '<ul class="md-tasklist">' +
            items
              .map((it) => {
                const checked = /^\[[xX]\]/.test(it);
                const label = it.replace(/^\[[ xX]\]\s*/, '');
                return `<li class="md-task"><span class="md-task-box${checked ? ' is-checked' : ''}" aria-hidden="true"></span><span>${label}</span></li>`;
              })
              .join('') +
            '</ul>'
        );
      } else {
        out.push(`<ul>${items.map((it) => `<li>${it}</li>`).join('')}</ul>`);
      }
      i = j - 1;
      continue;
    }

    const olMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (olMatch) {
      flushPara();
      const startNum = parseInt(olMatch[1], 10) || 1;
      const items = [olMatch[2]];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const nextTrim = lines[j].replace(/^\s+|\s+$/g, '');
        const m = nextTrim.match(/^(\d+)[.)]\s+(.*)$/);
        if (!m) break;
        items.push(m[2]);
      }
      out.push(`<ol start="${startNum}">${items.map((it) => `<li>${it}</li>`).join('')}</ol>`);
      i = j - 1;
      continue;
    }

    if (trimmed === '') {
      flushPara();
      continue;
    }
    paraBuf.push(trimmed);
  }
  flushPara();
  flushSources();

  let result = out.join('\n');
  result = result.replace(/ CODEBLOCK(\d+) /g, (_m, idx) =>
    `<pre><code>${escapeHtml(codeBlocks[Number(idx)] || '')}</code></pre>`
  );
  result += structuredSourcesHtml;
  return result;
}

// Карточка сгенерированного документа-вложения («Мои документы»).
export function renderAttachmentCard(att: MessageAttachment | null | undefined): string {
  if (!att || !att.id) return '';
  const id = encodeURIComponent(String(att.id));
  const title = escapeHtml(att.title || 'Документ');
  const filename = att.filename || 'document.docx';
  const viewUrl = `/documents/${id}/view`;
  const dlUrl = `/api/documents/${id}/download`;
  return (
    `<div class="chat-attachment">` +
    `<a class="chat-attachment-main" href="${escapeAttr(viewUrl)}" target="_blank" rel="noopener" title="Открыть для просмотра">` +
    `<div class="chat-attachment-icon">${sourceFileIcon()}</div>` +
    `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
    `<div class="chat-attachment-name">${escapeHtml(filename)}</div></div></a>` +
    `<a class="chat-attachment-action" href="${escapeAttr(dlUrl)}" title="Скачать" aria-label="Скачать">${ICONS.download}</a></div>`
  );
}
