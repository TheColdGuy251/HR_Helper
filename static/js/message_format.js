/* Общий рендер контента ассистента (единственный источник истины): markdown,
   перенумерация ссылок, блок «Источники» с карточками документов, карточка
   вложения. Используется чатом (/chat) и мессенджером (пересланные ответы ИИ),
   чтобы сообщения выглядели одинаково. Экспортируется как window.MsgFmt. */
window.MsgFmt = (function () {
  "use strict";
  const escapeHtml = window.escapeHtml || ((s) => String(s == null ? "" : s));
  const escapeAttr = window.escapeAttr || escapeHtml;

function renumberCitations(raw) {
    const text = String(raw || '');
    if (!/\[\d{1,3}\]/.test(text)) return text;

    const lines = text.split('\n');
    let hdr = -1, inlineTail = '';
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (/^#{0,6}\s*источник[а-яё]*\s*[:：]?\s*$/i.test(t)) { hdr = i; break; }
        const inl = t.match(/^#{0,6}\s*источник[а-яё]*\s*[:：]\s*(.+)$/i);
        if (inl) { hdr = i; inlineTail = inl[1]; break; }
    }
    if (hdr === -1) return text;

    const articleKey = (title) => {
        const a = title.match(/стат(?:ья|ьи|ью|ей|ьями|ьях)?\s*№?\s*(\d+(?:\.\d+)?)/i);
        return a ? ('ст' + a[1]) : title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 50);
    };
    const entries = [];
    const parseEntry = (s) => {
        const nums = [];
        let m; const re = /\[(\d{1,3})\]/g;
        while ((m = re.exec(s))) nums.push(parseInt(m[1], 10));
        const title = s.replace(/\[\d{1,3}\]/g, '').replace(/^[\s,;.\-*+]+/, '').replace(/\s{2,}/g, ' ').trim();
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

    const chunkInfo = {};
    for (const e of entries) {
        const key = articleKey(e.title);
        for (const n of e.nums) chunkInfo[n] = { title: e.title, key };
    }

    const body = lines.slice(0, hdr).join('\n');
    // Во время стрима блок «Источники» ещё неполон: если не все ссылки текста
    // разрешаются — не трогаем (иначе бейджи мигают/пропадают до конца стрима).
    const bodyRefs = new Set();
    let br; const brRe = /\[(\d{1,3})\]/g;
    while ((br = brRe.exec(body))) bodyRefs.add(parseInt(br[1], 10));
    for (const n of bodyRefs) if (!(n in chunkInfo)) return text;

    const keyToNew = {}; const ordered = [];
    let m; const refRe = /\[(\d{1,3})\]/g;
    while ((m = refRe.exec(body))) {
        const info = chunkInfo[parseInt(m[1], 10)];
        if (!info) continue;
        if (!(info.key in keyToNew)) {
            keyToNew[info.key] = ordered.length + 1;
            ordered.push({ num: ordered.length + 1, title: info.title });
        }
    }
    // источники, не упомянутые в тексте — в конец списка
    for (const e of entries) {
        const key = articleKey(e.title);
        if (!(key in keyToNew)) {
            keyToNew[key] = ordered.length + 1;
            ordered.push({ num: ordered.length + 1, title: e.title });
        }
    }
    if (!ordered.length) return text;

    let newBody = body.replace(/\[(\d{1,3})\]/g, (full, d) => {
        const info = chunkInfo[parseInt(d, 10)];
        if (!info) return '';                 // неизвестная ссылка — убираем (меньше спама)
        return `[${keyToNew[info.key]}]`;
    });
    // схлопываем подряд идущие одинаковые ссылки: «[1] , [1] [1]» → «[1]»
    newBody = newBody.replace(/(\[(\d+)\])(?:\s*[,;]?\s*\[\2\])+/g, '[$2]');
    // подчищаем висячие запятые/пробелы после удалённых ссылок
    newBody = newBody.replace(/\s+([,;])/g, '$1').replace(/([(,;])\s*([,;)])/g, '$1$2').replace(/[ \t]{2,}/g, ' ');

    const srcMd = '## Источники\n' + ordered.map((o) => `- [${o.num}] ${o.title}`).join('\n');
    return newBody.replace(/\s+$/, '') + '\n\n' + srcMd;
}

// Строит блок «Источники» и перенумерацию из СТРУКТУРНЫХ данных (result.sources),
// а не из текста модели (он бывает неполным). citation [k] ↔ sources[k-1].
// Возвращает {body, entries}: body с новыми номерами, entries — упорядоченные источники.
function buildSourcesFromStructured(rawText, sources) {
    const lines = rawText.split('\n');
    let hdr = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^#{0,6}\s*источник/i.test(lines[i].trim())) { hdr = i; break; }
    }
    const body = (hdr === -1 ? rawText : lines.slice(0, hdr).join('\n')).replace(/\s+$/, '');

    const keyOf = (src) => ((src.article || src.title || '').toLowerCase().replace(/\s+/g, ' ').trim());
    const keyToNew = {}; const ordered = [];
    // Считаем РЕАЛЬНО использованные источники по ВСЕМУ тексту (включая раздел
    // «Источники», который модель пишет сама) — блок появляется только если в ответе
    // есть ссылки [k]. Нет ссылок → нет блока (модель источники не применяла).
    let m; const refRe = /\[(\d{1,3})\]/g;
    while ((m = refRe.exec(rawText))) {
        const src = sources[parseInt(m[1], 10) - 1];
        if (!src || src.type === 'system') continue;   // синтетические справки — не источник
        const key = keyOf(src) || ('#' + m[1]);
        if (!(key in keyToNew)) {
            keyToNew[key] = ordered.length + 1;
            ordered.push({ num: ordered.length + 1, src, key });
        }
    }
    let newBody = body.replace(/\[(\d{1,3})\]/g, (full, d) => {
        const src = sources[parseInt(d, 10) - 1];
        if (!src || src.type === 'system') return '';
        const key = keyOf(src) || ('#' + d);
        return key in keyToNew ? `[${keyToNew[key]}]` : '';
    });
    newBody = newBody
        .replace(/(\[(\d+)\])(?:\s*[,;]?\s*\[\2\])+/g, '[$2]')
        .replace(/\s+([,;])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ');

    // Без ссылок в тексте блок источников НЕ показываем (источники не использованы).
    return { body: newBody, entries: ordered };
}

// Иконка по расширению файла источника.
function sourceFileIcon(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return 'fa-file-pdf';
    if (ext === 'doc' || ext === 'docx') return 'fa-file-word';
    if (ext === 'xls' || ext === 'xlsx' || ext === 'xlsm') return 'fa-file-excel';
    if (ext === 'md' || ext === 'markdown') return 'fa-file-lines';
    if (ext === 'txt' || ext === 'rst') return 'fa-file-lines';
    return 'fa-file-lines';
}

// Карточка документа-источника: клик по телу — открыть просмотрщик, отдельная кнопка — скачать.
function renderSourceDocCard(src) {
    const title = escapeHtml(src.title || 'Документ');
    // Прикреплённый в чате документ (#7) — карточка в том же стиле, без ссылки на БЗ.
    if (src.type === 'attachment') {
        const icon = sourceFileIcon(src.title || '');
        return `<div class="chat-attachment chat-attachment-pinned" title="Прикреплён к диалогу">` +
            `<div class="chat-attachment-icon"><i class="fas ${icon}"></i></div>` +
            `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
            `<div class="chat-attachment-name">прикреплён к диалогу</div></div>` +
            `<div class="chat-attachment-action"><i class="fas fa-paperclip"></i></div></div>`;
    }
    if (src.source_type === 'news' && src.url) {
        return `<a class="chat-attachment" href="${escapeAttr(src.url)}" target="_blank" rel="noopener" title="Открыть новость">` +
            `<div class="chat-attachment-icon"><i class="fas fa-newspaper"></i></div>` +
            `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
            `<div class="chat-attachment-name">Новости HR</div></div>` +
            `<div class="chat-attachment-action"><i class="fas fa-arrow-up-right-from-square"></i></div></a>`;
    }
    if (src.document_id) {
        const id = encodeURIComponent(src.document_id);
        const viewUrl = `/kb/documents/${id}/view`;
        const dlUrl = `/api/kb/documents/${id}/download`;
        const filename = (src.uri || '').split(/[\\/]/).pop() || '';
        const icon = sourceFileIcon(filename);
        return `<div class="chat-attachment">` +
            `<a class="chat-attachment-main" href="${escapeAttr(viewUrl)}" target="_blank" rel="noopener" title="Открыть для просмотра">` +
            `<div class="chat-attachment-icon"><i class="fas ${icon}"></i></div>` +
            `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
            (filename ? `<div class="chat-attachment-name">${escapeHtml(filename)}</div>` : '') + `</div></a>` +
            `<a class="chat-attachment-action" href="${escapeAttr(dlUrl)}" title="Скачать" aria-label="Скачать">` +
            `<i class="fas fa-download"></i></a></div>`;
    }
    if (src.uri && /^https?:/i.test(src.uri)) {
        return `<a class="chat-attachment" href="${escapeAttr(src.uri)}" target="_blank" rel="noopener">` +
            `<div class="chat-attachment-icon"><i class="fas fa-globe"></i></div>` +
            `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
            `<div class="chat-attachment-name">${escapeHtml(src.uri)}</div></div>` +
            `<div class="chat-attachment-action"><i class="fas fa-arrow-up-right-from-square"></i></div></a>`;
    }
    return '';
}

function renderStructuredSources(entries) {
    if (!entries || !entries.length) return '';
    // Ссылки (статьи) — показываем ВСЕ, компактно.
    const refs = entries.map((e) => {
        const label = escapeHtml(e.src.article || e.src.title || 'Источник');
        return `<span class="md-ref"><sup class="md-src-ref">${e.num}</sup>${label}</span>`;
    }).join('');

    // Документы — уникальные файлы, карточками; >3 → излишек в модалку.
    const docMap = new Map();
    for (const e of entries) {
        const src = e.src || {};
        const key = src.document_id ? ('d' + src.document_id)
            : src.attachment_id ? ('a' + src.attachment_id)
            : (src.uri || src.url || '');
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

    return `<div class="md-sources"><div class="md-sources-title">Источники</div>` +
           `<div class="md-refs">${refs}</div>${docsHtml}</div>`;
}

function formatMessageContent(raw, sources, includeSources = true) {
    if (raw === null || typeof raw === 'undefined') return '';
    let s = String(raw);

    s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\r\n/g, '\n');

    // Источники из структурных данных, если они есть (надёжнее текста модели);
    // иначе — текстовая перенумерация по блоку «Источники» из ответа.
    // Нумерацию ссылок делаем всегда (live во время стрима), но сам блок «Источники»
    // добавляем только когда includeSources=true (после завершения генерации).
    let structuredSourcesHtml = '';
    if (Array.isArray(sources) && sources.length) {
        const built = buildSourcesFromStructured(s, sources);
        s = built.body;
        if (includeSources) structuredSourcesHtml = renderStructuredSources(built.entries);
    } else {
        s = renumberCitations(s);
    }

    const codeBlocks = [];
    s = s.replace(/```([\s\S]*?)```/g, (_m, p1) => {
        const idx = codeBlocks.push(p1) - 1;
        return ` CODEBLOCK${idx} `;
    });
    const inlineCodes = [];
    s = s.replace(/`([^`\n]+?)`/g, (_m, p1) => {
        const idx = inlineCodes.push(p1) - 1;
        return ` INLINECODE${idx} `;
    });

    s = escapeHtml(s);

    s = s.replace(/ INLINECODE(\d+) /g, (_m, idx) =>
        `<code class="md-inline-code">${escapeHtml(inlineCodes[Number(idx)] || '')}</code>`);

    s = s.replace(/\[([^\]]+)\]\(((?:https?:)?\/\/[^)]+)\)/g, (_m, text, url) =>
        `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);

    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<![\w*])\*(?!\*)([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/(?<![\w_])_([^_\n]+?)_(?![\w_])/g, '<em>$1</em>');

    s = s.replace(/(?<![\w(])\[(\d{1,3})\](?!\()/g, '<sup class="md-src-ref">$1</sup>');

    s = s.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');

    const lines = s.split('\n');
    const out = [];
    let paraBuf = [];
    let inSources = false;
    let sourcesBuf = [];

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
            if (/^источник/i.test(text)) { inSources = true; continue; }
            out.push(`<h${level}>${text}</h${level}>`);
            continue;
        }

        const inlineSrc = trimmed.match(/^источники\s*[:：]\s*(.+)$/i);
        if (inlineSrc) {
            flushPara();
            flushSources();
            inSources = true;
            const body = inlineSrc[1];
            const parts = body.split(/(?=<sup class="md-src-ref">)/).map((x) => x.trim()).filter(Boolean);
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
            if (m) { sourcesBuf.push(m[1]); continue; }
            if (trimmed === '') { flushSources(); continue; }
            sourcesBuf.push(trimmed);
            continue;
        }

        const bq = trimmed.match(/^>\s?(.*)$/);
        if (bq) {
            flushPara();
            const bqLines = [bq[1]];
            let j = i + 1;
            for (; j < lines.length; j++) {
                const nextTrim = lines[j].replace(/^\s+|\s+$/g, '');
                const bqn = nextTrim.match(/^>\s?(.*)$/);
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
            // task-list (- [ ] / - [x]) — рендерим квадратиками
            const isTaskList = items.every((it) => /^\[[ xX]\]\s*/.test(it));
            if (isTaskList) {
                out.push(
                    '<ul class="md-tasklist">' +
                    items.map((it) => {
                        const checked = /^\[[xX]\]/.test(it);
                        const label = it.replace(/^\[[ xX]\]\s*/, '');
                        return `<li class="md-task"><span class="md-task-box${checked ? ' is-checked' : ''}" aria-hidden="true"></span><span>${label}</span></li>`;
                    }).join('') +
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

        if (trimmed === '') { flushPara(); continue; }
        paraBuf.push(trimmed);
    }
    flushPara();
    flushSources();

    let result = out.join('\n');
    result = result.replace(/ CODEBLOCK(\d+) /g, (_m, idx) =>
        `<pre><code>${escapeHtml(codeBlocks[Number(idx)] || '')}</code></pre>`);
    result += structuredSourcesHtml;  // блок «Источники» из структурных данных (если есть)
    return result;
}

function renderAttachmentCard(att) {
    if (!att || !att.id) return '';
    const id = encodeURIComponent(att.id);
    const title = window.escapeHtml(att.title || 'Документ');
    const filename = att.filename || 'document.docx';
    const icon = sourceFileIcon(filename);
    const viewUrl = `/documents/${id}/view`;
    const dlUrl = `/api/documents/${id}/download`;
    return `<div class="chat-attachment">` +
        `<a class="chat-attachment-main" href="${escapeAttr(viewUrl)}" target="_blank" rel="noopener" title="Открыть для просмотра">` +
        `<div class="chat-attachment-icon"><i class="fas ${icon}"></i></div>` +
        `<div class="chat-attachment-body"><div class="chat-attachment-title">${title}</div>` +
        `<div class="chat-attachment-name">${window.escapeHtml(filename)}</div></div></a>` +
        `<a class="chat-attachment-action" href="${escapeAttr(dlUrl)}" title="Скачать" aria-label="Скачать">` +
        `<i class="fas fa-download"></i></a></div>`;
}

  return { formatMessageContent, renderAttachmentCard, renderStructuredSources, buildSourcesFromStructured, sourceFileIcon };
})();
