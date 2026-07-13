/* /kb — управление документами, источниками, шаблонами, персональными данными. */

document.addEventListener('DOMContentLoaded', function () {
  /* ============ TABS ============ */
  const tabs = document.querySelectorAll('.kb-tab');
  const panels = document.querySelectorAll('.kb-panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      panels.forEach((p) => { p.style.display = p.dataset.panel === name ? '' : 'none'; });
      if (name === 'documents') loadDocs();
      if (name === 'sources')   loadSources();
      if (name === 'templates') { loadCategories().then(loadTemplates); }
      if (name === 'personal')  initPiiTab();
      if (name === 'faq')       loadFaq();
    });
  });

  /* ============ Общие утилиты ============ */
  const escapeHtml = window.escapeHtml;
  const escapeAttr = window.escapeAttr;

  function filterCards(container, query, selector = '.kb-item, .kb-person-group') {
    const q = (query || '').trim().toLowerCase();
    container.querySelectorAll(selector).forEach((el) => {
      if (!q) { el.style.display = ''; return; }
      const t = (el.textContent || '').toLowerCase();
      el.style.display = t.includes(q) ? '' : 'none';
    });
  }

  /* ============ ДОКУМЕНТЫ ============ */
  const uploadBtn   = document.getElementById('kbUploadBtn');
  const fileInput   = document.getElementById('kbFileInput');
  const statusBox   = document.getElementById('kbUploadStatus');
  const statusText  = document.getElementById('kbUploadText');
  const progressBar = document.getElementById('kbProgressBar');
  const docsList    = document.getElementById('kbDocsList');
  const docsSearch  = document.getElementById('kbDocsSearch');

  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await uploadDocument(file);
      fileInput.value = '';
    });
  }
  if (docsSearch) {
    docsSearch.addEventListener('input', () => filterCards(docsList, docsSearch.value));
  }

  // Импорт документов из выгрузки 1С (ZIP) — #18
  const oneCFileInput = document.getElementById('kb1cFileInput');
  if (oneCFileInput) {
    oneCFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      statusBox.style.display = 'block';
      statusBox.className = 'kb-upload-status';
      statusText.textContent = `Импорт из 1С: «${file.name}»…`;
      progressBar.style.width = '20%';
      const form = new FormData();
      form.append('file', file);
      try {
        const resp = await fetch('/api/kb/import/1c', { method: 'POST', body: form });
        progressBar.style.width = '100%';
        const data = await resp.json();
        if (resp.ok && data.success) {
          statusBox.className = 'kb-upload-status success';
          statusText.textContent = `Импортировано документов: ${data.queued}, пропущено: ${data.skipped}. Идёт индексация…`;
          loadDocs();
          setTimeout(() => { statusBox.style.display = 'none'; loadDocs(); }, 6000);
        } else {
          statusBox.className = 'kb-upload-status error';
          statusText.textContent = `Ошибка: ${data.detail || data.error || '?'}`;
        }
      } catch (err) {
        statusBox.className = 'kb-upload-status error';
        statusText.textContent = `Ошибка соединения: ${err.message}`;
      } finally {
        oneCFileInput.value = '';
      }
    });
  }

  async function uploadDocument(file) {
    statusBox.style.display = 'block';
    statusBox.className = 'kb-upload-status';
    statusText.textContent = `Загрузка и индексация «${file.name}»…`;
    progressBar.style.width = '15%';

    const form = new FormData();
    form.append('file', file);
    try {
      const resp = await fetch('/api/kb/upload', { method: 'POST', body: form });
      progressBar.style.width = '100%';
      const data = await resp.json();
      if (resp.ok && data.success) {
        statusBox.className = 'kb-upload-status';
        statusText.textContent = `Документ «${data.document.title}» загружен, идёт индексация…`;
        loadDocs();
        if (data.document && data.document.id) {
          pollDocStatus(data.document.id, data.document.title);
        } else {
          setTimeout(() => { statusBox.style.display = 'none'; }, 4000);
        }
      } else {
        statusBox.className = 'kb-upload-status error';
        statusText.textContent = `Ошибка: ${data.detail || data.error || '?'}`;
      }
    } catch (err) {
      statusBox.className = 'kb-upload-status error';
      statusText.textContent = `Ошибка соединения: ${err.message}`;
    }
  }

  // Опрашиваем статус документа, пока фоновая индексация не завершится.
  async function pollDocStatus(docId, title, attempt = 0) {
    if (attempt > 300) return;  // ~10 минут максимум
    try {
      const resp = await fetch('/api/kb/documents');
      const data = await resp.json();
      const doc = (data.items || []).find((d) => d.id === docId);
      renderDocs(data.items || []);
      // Живой прогресс: стадия + N/M чанков + процент в прогресс-баре.
      if (doc && (doc.status === 'pending' || doc.status === 'parsing') && doc.progress) {
        const p = doc.progress;
        statusText.textContent = `«${doc.title || title}»: ${p.label}` +
          (p.total ? ` — ${p.done}/${p.total} чанков` : '') + ` (${p.percent}%)`;
        progressBar.style.width = p.percent + '%';
      }
      if (doc && doc.status === 'indexed') {
        statusBox.className = 'kb-upload-status success';
        progressBar.style.width = '100%';
        statusText.textContent = `Документ «${doc.title || title}» проиндексирован (${doc.chunks_count || 0} чанков).`;
        setTimeout(() => { statusBox.style.display = 'none'; }, 4000);
        _uploadPolling = false;
        return;
      }
      if (doc && doc.status === 'failed') {
        statusBox.className = 'kb-upload-status error';
        statusText.textContent = `Не удалось проиндексировать «${doc.title || title}»: ${doc.error || 'ошибка парсинга'}`;
        _uploadPolling = false;
        return;
      }
      if (!doc) {  // дубликат — placeholder удалён
        statusBox.className = 'kb-upload-status success';
        statusText.textContent = 'Документ уже есть в базе знаний.';
        setTimeout(() => { statusBox.style.display = 'none'; }, 4000);
        _uploadPolling = false;
        return;
      }
    } catch (e) { /* пробуем ещё */ }
    _uploadPolling = true;
    setTimeout(() => pollDocStatus(docId, title, attempt + 1), 2000);
  }

  // Иконка и цветовой класс по типу документа (расширению файла / веб-источнику).
  function kbDocIcon(d) {
    if (d.source_type === 'web') return { icon: 'fa-globe', cls: 'ft-web' };
    const name = d.filename || d.source_uri || '';
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return { icon: 'fa-file-pdf', cls: 'ft-pdf' };
    if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return { icon: 'fa-file-word', cls: 'ft-word' };
    if (['xls', 'xlsx', 'xlsm', 'ods', 'csv'].includes(ext)) return { icon: 'fa-file-excel', cls: 'ft-excel' };
    if (['ppt', 'pptx', 'odp'].includes(ext)) return { icon: 'fa-file-powerpoint', cls: 'ft-ppt' };
    if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif'].includes(ext)) return { icon: 'fa-file-image', cls: 'ft-image' };
    if (['md', 'rst'].includes(ext)) return { icon: 'fa-file-lines', cls: 'ft-md' };
    if (['txt', 'log'].includes(ext)) return { icon: 'fa-file-lines', cls: 'ft-txt' };
    return { icon: 'fa-file-alt', cls: 'ft-other' };
  }

  const PRIORITY_LABELS = { 1: 'Низкий', 2: 'Средний', 3: 'Высокий' };
  function priorityPill(p, kind) {
    const v = Number(p || 2);
    return `<button class="kb-priority kb-priority-${v}" data-priority="${v}" data-kind="${kind}">${PRIORITY_LABELS[v]}</button>`;
  }

  let _uploadPolling = false;      // активен ли поллинг после свежей загрузки
  let _docsRefreshTimer = null;

  async function loadDocs(silent) {
    if (!silent) docsList.innerHTML = '<div class="kb-loader">Загрузка…</div>';
    try {
      const resp = await fetch('/api/kb/documents');
      const data = await resp.json();
      renderDocs(data.items || []);
      // Пока что-то индексируется — автообновление карточек (работает и после
      // перезагрузки страницы: индексация серверная и не прерывается).
      clearTimeout(_docsRefreshTimer);
      const busy = (data.items || []).some((d) => d.status === 'pending' || d.status === 'parsing');
      if (busy && !_uploadPolling) {
        _docsRefreshTimer = setTimeout(() => loadDocs(true), 2500);
      }
    } catch (err) {
      if (!silent) docsList.innerHTML = '<div class="kb-empty">Ошибка загрузки</div>';
    }
  }

  function renderDocs(items) {
    if (!items.length) {
      docsList.innerHTML = '<div class="kb-empty">В базе знаний пока нет документов. Загрузите первый файл выше.</div>';
      return;
    }
    // Сводка по актуальности (пересмотр ≥ 1 раза в год; отвечает редактор БЗ).
    const expired = items.filter((d) => d.review_status === 'expired').length;
    const due = items.filter((d) => d.review_status === 'review_due').length;
    let summary = '';
    if (expired || due) {
      const parts = [];
      if (expired) parts.push(`<b>${expired}</b> с истёкшим сроком`);
      if (due) parts.push(`<b>${due}</b> без пересмотра больше года`);
      summary = `<div class="kb-review-summary"><i class="fas fa-clock-rotate-left"></i> ` +
        `Требуют внимания: ${parts.join(', ')}. Обновите текст/даты действия или архивируйте устаревшие.</div>`;
    }
    docsList.innerHTML = summary + items.map((d) => {
      const isWeb = d.source_type === 'web';
      const openTitle = isWeb ? 'Открыть источник' : 'Скачать файл';
      const openIcon = isWeb ? 'fa-external-link-alt' : 'fa-download';
      const openBtn = d.status === 'indexed'
        ? `<a class="kb-icon-btn kb-icon-btn-open" href="/api/kb/documents/${d.id}/download" target="_blank" rel="noopener" title="${openTitle}"><i class="fas ${openIcon}"></i></a>`
        : '<span class="kb-icon-btn kb-icon-btn-disabled" title="Документ ещё не готов"><i class="fas fa-download"></i></span>';
      // Просмотр (отдельная кнопка) — для готовых документов; веб-источник откроется в оригинале
      const viewBtn = d.status === 'indexed'
        ? `<a class="kb-icon-btn kb-icon-btn-view" href="/kb/documents/${d.id}/view" target="_blank" rel="noopener" title="Открыть для просмотра"><i class="fas fa-eye"></i></a>`
        : '';
      // Кнопки OCR-сплита нет: /view для OCR-документов сам открывает режим
      // «оригинал + распознанный текст» — отдельная кнопка дублировала просмотр.
      const titleInner = `${escapeHtml(d.title)}${d.is_archived ? ' <span class="kb-badge kb-badge-archived" title="Архивная редакция">архив</span>' : ''}`;
      const titleHtml = d.status === 'indexed'
        ? `<a class="kb-item-title-link" href="/kb/documents/${d.id}/view" target="_blank" rel="noopener" title="Открыть для просмотра">${titleInner}</a>`
        : titleInner;
      const prog = (d.status === 'pending' || d.status === 'parsing') ? d.progress : null;
      const statusLabel = prog
        ? `Индексация ${prog.percent}%`
        : (({ indexed: 'Готов', pending: 'В очереди', parsing: 'Индексация', failed: 'Ошибка' })[d.status] || d.status);
      const meta = [
        d.filename ? `📎 ${d.filename}` : null,
        prog ? `${prog.label}${prog.total ? ` — ${prog.done}/${prog.total} чанков` : ''}` : null,
        !prog && d.chunks_count ? `${d.chunks_count} чанков` : null,
        d.indexed_at ? new Date(d.indexed_at).toLocaleString('ru-RU') : new Date(d.created_at).toLocaleString('ru-RU'),
      ].filter(Boolean).join(' • ');

      const badges = renderDocBadges(d);
      const ficon = kbDocIcon(d);
      return `
      <div class="kb-item" data-doc-id="${d.id}">
        <div class="kb-item-icon ${ficon.cls} ${d.status === 'failed' ? 'failed' : ''}"><i class="fas ${ficon.icon}"></i></div>
        <div class="kb-item-body">
          <div class="kb-item-title">${titleHtml}</div>
          <div class="kb-item-meta">${escapeHtml(meta)}${d.error ? ' • ' + escapeHtml(d.error) : ''}</div>
          ${badges}
        </div>
        ${priorityPill(d.priority, 'document')}
        <span class="kb-status ${d.status}">${statusLabel}</span>
        ${viewBtn}
        ${openBtn}
        <button class="kb-icon-btn kb-icon-btn-meta" title="Изменить метаданные" data-meta-doc="${d.id}"><i class="fas fa-sliders-h"></i></button>
        <button class="kb-icon-btn kb-icon-btn-danger" title="Удалить" data-delete-doc="${d.id}"><i class="fas fa-trash"></i></button>
      </div>`;
    }).join('');

    docsList.querySelectorAll('[data-delete-doc]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить документ?')) return;
        await fetch(`/api/kb/documents/${btn.dataset.deleteDoc}`, { method: 'DELETE' });
        loadDocs();
      });
    });
    docsList.querySelectorAll('[data-meta-doc]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const docId = Number(btn.dataset.metaDoc);
        const doc = items.find((x) => x.id === docId);
        if (doc) openDocMetaModal(doc);
      });
    });
    docsList.querySelectorAll('.kb-priority[data-kind="document"]').forEach((btn) => {
      btn.addEventListener('click', (e) => showPriorityMenu(e, btn, 'document'));
    });
    if (docsSearch) filterCards(docsList, docsSearch.value);
  }

  const KIND_LABELS = {
    code: 'Кодекс', law: 'Закон', regulation: 'Положение',
    order: 'Приказ', manual: 'Инструкция', other: 'Прочее',
  };

  function renderDocBadges(d) {
    const out = [];
    if (d.review_status === 'expired') {
      out.push('<span class="kb-badge kb-badge-expired" title="Вышел срок действия (effective_to в прошлом) — обновите или архивируйте"><i class="fas fa-triangle-exclamation"></i> устарел</span>');
    } else if (d.review_status === 'review_due') {
      out.push('<span class="kb-badge kb-badge-review" title="Не пересматривался больше года — проверьте актуальность (пересмотр ≥ 1 раза в год)"><i class="fas fa-clock-rotate-left"></i> пора пересмотреть</span>');
    }
    if (d.document_kind) {
      out.push(`<span class="kb-badge kb-badge-kind" title="Тип документа">${escapeHtml(KIND_LABELS[d.document_kind] || d.document_kind)}</span>`);
    }
    if (d.issuer) {
      out.push(`<span class="kb-badge kb-badge-issuer" title="Издатель">${escapeHtml(d.issuer)}</span>`);
    }
    if (d.ocr_applied) {
      out.push(`<span class="kb-badge kb-badge-ocr" title="Текст распознан через OCR">OCR</span>`);
    }
    if (d.pii_warning) {
      const p = d.pii_warning;
      const tip = `Возможны персональные данные: ${p.reason || ''}`
        + (p.samples && p.samples.length ? ` (${p.samples.join(', ')}…)` : '')
        + '. В общей базе знаний ПДн быть не должно — используйте раздел «Персональные данные».';
      out.push(`<span class="kb-badge kb-badge-pii" title="${escapeAttr(tip)}"><i class="fas fa-user-shield"></i> ПДн?</span>`);
    }
    for (const t of (d.tags || []).slice(0, 5)) {
      out.push(`<span class="kb-badge kb-badge-tag">#${escapeHtml(t)}</span>`);
    }
    if (!out.length) return '';
    return `<div class="kb-doc-badges">${out.join('')}</div>`;
  }

  /* === Метаданные документа === */
  let _editingDocId = null;
  let _kindCSelect = null;
  let _priorityCSelect = null;
  function openDocMetaModal(doc) {
    _editingDocId = doc.id;
    const modal = document.getElementById('kbDocMetaModal');
    document.getElementById('kbDMTitle').textContent = doc.title || '';
    document.getElementById('kbDM_title').value = doc.title || '';
    const kindEl = document.getElementById('kbDM_kind');
    const priEl = document.getElementById('kbDM_priority');
    kindEl.value = doc.document_kind || '';
    priEl.value = String(doc.priority || 2);
    if (window.makeCustomSelect) {
      if (!_kindCSelect) _kindCSelect = window.makeCustomSelect(kindEl);
      else _kindCSelect.refresh();
      if (!_priorityCSelect) _priorityCSelect = window.makeCustomSelect(priEl);
      else _priorityCSelect.refresh();
    }
    document.getElementById('kbDM_issuer').value = doc.issuer || '';
    document.getElementById('kbDM_from').value = doc.effective_from || '';
    document.getElementById('kbDM_to').value = doc.effective_to || '';
    document.getElementById('kbDM_tags').value = (doc.tags || []).join(', ');
    document.getElementById('kbDM_archived').checked = !!doc.is_archived;
    modal.style.display = 'flex';
  }
  function closeDocMetaModal() {
    document.getElementById('kbDocMetaModal').style.display = 'none';
    _editingDocId = null;
  }
  document.getElementById('kbDocMetaClose')?.addEventListener('click', closeDocMetaModal);
  document.getElementById('kbDM_cancel')?.addEventListener('click', closeDocMetaModal);
  document.getElementById('kbDocMetaModal')?.querySelector('.kb-modal-overlay')?.addEventListener('click', closeDocMetaModal);
  document.getElementById('kbDM_submit')?.addEventListener('click', async () => {
    if (!_editingDocId) return;
    const tagsRaw = document.getElementById('kbDM_tags').value || '';
    const body = {
      title: document.getElementById('kbDM_title').value.trim(),
      document_kind: document.getElementById('kbDM_kind').value || null,
      issuer: document.getElementById('kbDM_issuer').value.trim() || null,
      priority: Number(document.getElementById('kbDM_priority').value),
      effective_from: document.getElementById('kbDM_from').value || null,
      effective_to: document.getElementById('kbDM_to').value || null,
      tags: tagsRaw.split(',').map((t) => t.trim()).filter(Boolean),
      is_archived: document.getElementById('kbDM_archived').checked,
    };
    const btn = document.getElementById('kbDM_submit');
    btn.disabled = true;
    try {
      const resp = await fetch(`/api/kb/documents/${_editingDocId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert('Ошибка: ' + (err.detail || resp.status));
        return;
      }
      closeDocMetaModal();
      loadDocs();
    } catch (e) {
      alert('Ошибка соединения: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  function showPriorityMenu(e, anchor, kind) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.kb-priority-menu').forEach((m) => m.remove());

    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'kb-priority-menu';
    // position: fixed → координаты от viewport, без scroll-смещения.
    const menuWidth = 170;
    let left = rect.left;
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - menuWidth - 8);
    }
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${left}px`;
    menu.innerHTML = [
      { v: 3, label: 'Высокий', icon: 'fa-circle', color: '#16a34a' },
      { v: 2, label: 'Средний', icon: 'fa-circle', color: '#1e40af' },
      { v: 1, label: 'Низкий',  icon: 'fa-circle', color: '#ca8a04' },
    ].map((o) => `<button data-pv="${o.v}"><i class="fas ${o.icon}" style="color:${o.color}"></i> ${o.label}</button>`).join('');
    document.body.appendChild(menu);

    const item = anchor.closest('.kb-item');
    const docId = item && item.dataset.docId;
    const srcId = item && item.dataset.srcId;

    menu.querySelectorAll('button[data-pv]').forEach((b) => {
      b.addEventListener('click', async () => {
        const pv = Number(b.dataset.pv);
        menu.remove();
        try {
          let resp;
          if (kind === 'document' && docId) {
            resp = await fetch(`/api/kb/documents/${docId}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: pv })
            });
            if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
            loadDocs();
          } else if (kind === 'source' && srcId) {
            resp = await fetch(`/api/kb/sources/${srcId}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: pv })
            });
            if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
            loadSources();
          }
        } catch (err) {
          console.error('priority update failed:', err);
          alert('Не удалось изменить приоритет: ' + err.message);
        }
      });
    });
    setTimeout(() => {
      const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', off); } };
      document.addEventListener('click', off);
    }, 0);
  }

  /* ============ ВЕБ-ИСТОЧНИКИ ============ */
  const sourceForm = document.getElementById('kbSourceForm');
  const sourcesList = document.getElementById('kbSourcesList');
  const sourcesSearch = document.getElementById('kbSourcesSearch');

  if (sourceForm) {
    sourceForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        name: document.getElementById('kbSrcName').value.trim(),
        url:  document.getElementById('kbSrcUrl').value.trim(),
        refresh_interval_hours: parseInt(document.getElementById('kbSrcInterval').value || '24', 10),
      };
      try {
        const resp = await fetch('/api/kb/sources', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
          sourceForm.reset();
          document.getElementById('kbSrcInterval').value = 24;
          loadSources();
          // Индексация идёт в фоне — подтягиваем статус/кнопку предпросмотра по мере готовности.
          setTimeout(loadSources, 3000);
          setTimeout(loadSources, 9000);
        } else {
          alert(`Ошибка: ${data.detail || data.error || '?'}`);
        }
      } catch (err) { alert(`Ошибка: ${err.message}`); }
    });
  }
  if (sourcesSearch) sourcesSearch.addEventListener('input', () => filterCards(sourcesList, sourcesSearch.value));

  async function loadSources() {
    sourcesList.innerHTML = '<div class="kb-loader">Загрузка…</div>';
    try {
      const resp = await fetch('/api/kb/sources');
      const data = await resp.json();
      renderSources(data.items || []);
    } catch (err) {
      sourcesList.innerHTML = '<div class="kb-empty">Ошибка загрузки</div>';
    }
  }

  function renderSources(items) {
    if (!items.length) {
      sourcesList.innerHTML = '<div class="kb-empty">Источники не настроены.</div>';
      return;
    }
    sourcesList.innerHTML = items.map((s) => {
      const last = s.last_crawled_at ? new Date(s.last_crawled_at).toLocaleString('ru-RU') : '—';
      const status = s.last_status ? escapeHtml(s.last_status) : 'ещё не парсился';
      // Состояние индексации распарсенного документа.
      let idxNote = 'индексируется…';
      if (s.doc_status === 'indexed') idxNote = `${s.chunks_count || 0} чанков`;
      else if (s.doc_status === 'failed') idxNote = 'ошибка парсинга';
      else if (!s.document_id) idxNote = 'нет данных';
      // Кнопка предпросмотра распарсенного текста (если документ уже проиндексирован).
      const previewBtn = (s.document_id && s.doc_status === 'indexed')
        ? `<a class="kb-icon-btn kb-icon-btn-view" href="/kb/documents/${s.document_id}/view" target="_blank" rel="noopener" title="Предпросмотр распарсенного текста"><i class="fas fa-eye"></i></a>`
        : '';
      return `
      <div class="kb-item" data-src-id="${s.id}">
        <div class="kb-item-icon source"><i class="fas fa-globe"></i></div>
        <div class="kb-item-body">
          <div class="kb-item-title">${escapeHtml(s.name)}</div>
          <div class="kb-item-meta">
            <a href="${escapeAttr(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.url)}</a>
            • интервал ${s.refresh_interval_hours} ч • ${last} • ${status} • ${idxNote}
          </div>
        </div>
        ${priorityPill(s.priority, 'source')}
        <span class="kb-status ${s.is_enabled ? 'indexed' : 'pending'}">${s.is_enabled ? 'Активен' : 'Отключён'}</span>
        ${previewBtn}
        <button class="kb-icon-btn kb-icon-btn-danger" title="Удалить" data-src-del="${s.id}"><i class="fas fa-trash"></i></button>
      </div>`;
    }).join('');

    sourcesList.querySelectorAll('[data-src-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить источник?')) return;
        await fetch(`/api/kb/sources/${btn.dataset.srcDel}`, { method: 'DELETE' });
        loadSources();
      });
    });
    sourcesList.querySelectorAll('.kb-priority[data-kind="source"]').forEach((btn) => {
      btn.addEventListener('click', (e) => showPriorityMenu(e, btn, 'source'));
    });
    if (sourcesSearch) filterCards(sourcesList, sourcesSearch.value);
  }

  /* ============ ШАБЛОНЫ ============ */
  const tplForm = document.getElementById('kbTemplateForm');
  const tplFile = document.getElementById('kbTplFile');
  const tplFileLabel = document.getElementById('kbTplFileLabel');
  const tplStatus = document.getElementById('kbTplStatus');
  const tplStatusText = document.getElementById('kbTplStatusText');
  const tplList = document.getElementById('kbTemplatesList');
  const tplSearch = document.getElementById('kbTplSearch');
  const tplCategorySelect = document.getElementById('kbTplCategory');

  let _categories = [];
  let _categoryCSelect = null;
  async function loadCategories() {
    try {
      const resp = await fetch('/api/kb/template-categories');
      const data = await resp.json();
      _categories = data.items || [];
      if (tplCategorySelect) {
        tplCategorySelect.innerHTML = '<option value="">— выберите категорию —</option>' +
          _categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        if (!_categoryCSelect && window.makeCustomSelect) {
          _categoryCSelect = window.makeCustomSelect(tplCategorySelect);
        } else if (_categoryCSelect) {
          _categoryCSelect.refresh();
        }
      }
    } catch (e) { console.warn(e); }
  }

  if (tplFile) {
    tplFile.addEventListener('change', () => {
      const f = tplFile.files[0];
      tplFileLabel.textContent = f ? f.name : 'Выбрать .docx / .doc / .pdf';
    });
  }
  if (tplSearch) tplSearch.addEventListener('input', () => filterCards(tplList, tplSearch.value));

  if (tplForm) {
    tplForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = tplFile && tplFile.files[0];
      const title = document.getElementById('kbTplTitle').value.trim();
      const description = document.getElementById('kbTplDescription').value.trim();
      const categoryId = tplCategorySelect ? tplCategorySelect.value : '';
      if (!file) { alert('Выберите файл .docx, .doc или .pdf'); return; }
      if (!title) { alert('Введите название'); return; }

      tplStatus.style.display = 'block';
      tplStatus.className = 'kb-upload-status';
      tplStatusText.textContent = `Разбор шаблона «${file.name}»…`;

      const form = new FormData();
      form.append('file', file);
      form.append('title', title);
      if (description) form.append('description', description);
      if (categoryId) form.append('category_id', categoryId);

      try {
        const resp = await fetch('/api/kb/templates', { method: 'POST', body: form });
        const data = await resp.json();
        if (resp.ok && data.success) {
          tplStatus.className = 'kb-upload-status success';
          tplStatusText.textContent = `Шаблон добавлен, полей: ${data.template.fields_count}.`;
          tplForm.reset();
          tplFileLabel.textContent = 'Выбрать .docx';
          await loadCategories();
          loadTemplates();
          setTimeout(() => { tplStatus.style.display = 'none'; }, 3500);
        } else {
          tplStatus.className = 'kb-upload-status error';
          tplStatusText.textContent = `Ошибка: ${data.detail || '?'}`;
        }
      } catch (err) {
        tplStatus.className = 'kb-upload-status error';
        tplStatusText.textContent = `Ошибка соединения: ${err.message}`;
      }
    });
  }

  async function loadTemplates() {
    tplList.innerHTML = '<div class="kb-loader">Загрузка…</div>';
    try {
      const resp = await fetch('/api/kb/templates');
      const data = await resp.json();
      renderTemplates(data.items || []);
    } catch (err) {
      tplList.innerHTML = '<div class="kb-empty">Ошибка загрузки</div>';
    }
  }

  function renderTemplates(items) {
    if (!items.length) {
      tplList.innerHTML = '<div class="kb-empty">Шаблоны не загружены. Добавьте первый шаблон выше.</div>';
      return;
    }
    // Группировка по категории
    const byCat = new Map();
    for (const c of _categories) byCat.set(c.id, { cat: c, items: [] });
    const noCat = { cat: { id: null, name: 'Без категории', icon: 'fa-question', default_template_id: null }, items: [] };
    for (const t of items) {
      const slot = (t.category_id && byCat.get(t.category_id)) || noCat;
      slot.items.push(t);
    }
    const sections = [...byCat.values(), noCat].filter((s) => s.items.length > 0);

    tplList.innerHTML = sections.map((sec) => `
      <div class="kb-category-block">
        <div class="kb-category-header">
          <i class="fas ${sec.cat.icon || 'fa-folder'}"></i>
          ${escapeHtml(sec.cat.name)}
          <span class="kb-category-count">${sec.items.length} шт.</span>
        </div>
        ${sec.items.map((t) => {
          const isDefault = sec.cat.default_template_id === t.id;
          return `
          <div class="kb-item" data-tpl-id="${t.id}">
            <div class="kb-item-icon ${isDefault ? '' : ''}"><i class="fas fa-file-word"></i></div>
            <div class="kb-item-body">
              <div class="kb-item-title">
                ${escapeHtml(t.title)}
                ${isDefault ? '<span class="kb-tpl-default-mark"><i class="fas fa-star"></i> По умолчанию</span>' : ''}
              </div>
              <div class="kb-item-meta">${escapeHtml(t.description || '')}${t.description ? ' • ' : ''}полей: ${t.fields_count}</div>
            </div>
            ${sec.cat.id ? `<button class="kb-default-toggle ${isDefault ? 'is-default' : ''}" data-set-default="${t.id}" data-cat="${sec.cat.id}">${isDefault ? 'По умолчанию' : 'Сделать по умолчанию'}</button>` : ''}
            <a class="kb-icon-btn kb-icon-btn-view" href="/kb/templates/${t.id}/view" target="_blank" rel="noopener" title="Предпросмотр шаблона"><i class="fas fa-eye"></i></a>
            <a class="kb-icon-btn kb-icon-btn-open" href="/api/kb/templates/${t.id}/download" target="_blank" rel="noopener" title="Скачать оригинал"><i class="fas fa-download"></i></a>
            <button class="kb-icon-btn kb-icon-btn-danger" title="Удалить" data-tpl-del="${t.id}"><i class="fas fa-trash"></i></button>
          </div>`;
        }).join('')}
      </div>
    `).join('');

    tplList.querySelectorAll('[data-tpl-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить шаблон?')) return;
        await fetch(`/api/kb/templates/${btn.dataset.tplDel}`, { method: 'DELETE' });
        loadTemplates();
      });
    });
    tplList.querySelectorAll('[data-set-default]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tplId = btn.dataset.setDefault;
        const catId = btn.dataset.cat;
        const isAlreadyDefault = btn.classList.contains('is-default');
        await fetch(`/api/kb/template-categories/${catId}/default`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template_id: isAlreadyDefault ? null : Number(tplId) })
        });
        await loadCategories();
        loadTemplates();
      });
    });
    if (tplSearch) filterCards(tplList, tplSearch.value);
  }

  /* ============ ПЕРСОНАЛЬНЫЕ ДАННЫЕ ============ */
  const PII_DRAFT_KEY = 'hr_pii_draft_v1';
  const piiLocked   = document.getElementById('kbPiiLocked');
  const piiUnlocked = document.getElementById('kbPiiUnlocked');
  const piiList     = document.getElementById('kbPiiList');
  const piiSearch   = document.getElementById('kbPiiSearch');
  const piiCountdown= document.getElementById('kbPiiCountdown');
  const piiStatus   = document.getElementById('kbPiiStatus');
  const piiStatusText = document.getElementById('kbPiiStatusText');
  let piiCountdownTimer = null;
  let piiExpiresAt = 0;

  async function initPiiTab() {
    try {
      const resp = await fetch('/api/pii/session');
      const data = await resp.json();
      if (!data.can_access) {
        piiLocked.style.display = 'block';
        piiUnlocked.style.display = 'none';
        document.getElementById('kbPiiError').textContent = 'У вашей учётной записи нет доступа к этому разделу.';
        document.getElementById('kbPiiError').style.display = 'block';
        return;
      }
      if (data.active) {
        showPiiUnlocked(data.remaining_seconds || 0);
      } else {
        piiLocked.style.display = 'block';
        piiUnlocked.style.display = 'none';
      }
    } catch (e) { console.error(e); }
  }

  document.getElementById('kbPiiReauthForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('kbPiiPassword').value;
    const errEl = document.getElementById('kbPiiError');
    errEl.style.display = 'none';
    try {
      const resp = await fetch('/api/pii/reauth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errEl.textContent = data.detail || 'Ошибка';
        errEl.style.display = 'block';
        return;
      }
      document.getElementById('kbPiiPassword').value = '';
      showPiiUnlocked(data.expires_in);
      restoreDraftIfAny();
    } catch (err) {
      errEl.textContent = 'Ошибка соединения';
      errEl.style.display = 'block';
    }
  });

  document.getElementById('kbPiiLogout')?.addEventListener('click', async () => {
    await fetch('/api/pii/reauth/logout', { method: 'POST' });
    piiLocked.style.display = 'block';
    piiUnlocked.style.display = 'none';
    stopCountdown();
  });

  function showPiiUnlocked(ttlSec = 15 * 60) {
    piiLocked.style.display = 'none';
    piiUnlocked.style.display = 'block';
    piiExpiresAt = Date.now() + ttlSec * 1000;
    startCountdown();
    loadPersons();
  }

  function startCountdown() {
    stopCountdown();
    const tick = () => {
      const remain = Math.max(0, Math.floor((piiExpiresAt - Date.now()) / 1000));
      const mm = String(Math.floor(remain / 60)).padStart(2, '0');
      const ss = String(remain % 60).padStart(2, '0');
      if (piiCountdown) piiCountdown.textContent = `${mm}:${ss}`;
      if (remain <= 0) {
        stopCountdown();
        saveDraftOnTimeout();
        piiLocked.style.display = 'block';
        piiUnlocked.style.display = 'none';
        const errEl = document.getElementById('kbPiiError');
        errEl.textContent = 'Время сессии истекло. Ваши изменения сохранены — введите пароль для продолжения.';
        errEl.style.display = 'block';
      }
    };
    tick();
    piiCountdownTimer = setInterval(tick, 1000);
  }
  function stopCountdown() {
    if (piiCountdownTimer) { clearInterval(piiCountdownTimer); piiCountdownTimer = null; }
  }

  function saveDraftOnTimeout() {
    // Если в quick-modal что-то заполнено — сохраним в localStorage
    const modal = document.getElementById('kbQuickConfirmModal');
    if (modal && modal.style.display !== 'none') {
      const draft = {
        kind: 'quick',
        filename: document.getElementById('kbQuickFileName').textContent,
        surname: document.getElementById('kbQ_surname').value,
        name: document.getElementById('kbQ_name').value,
        patronymic: document.getElementById('kbQ_patronymic').value,
        birth_date: document.getElementById('kbQ_birth_date').value,
        note: document.getElementById('kbQ_note').value,
      };
      try { localStorage.setItem(PII_DRAFT_KEY, JSON.stringify(draft)); } catch (e) {}
    }
  }
  function restoreDraftIfAny() {
    try {
      const raw = localStorage.getItem(PII_DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.kind !== 'quick') return;
      // Открываем модалку с сохранёнными значениями, без файла — пользователь выберет повторно
      openQuickModal({
        filename: d.filename || '',
        recognized: {
          surname: d.surname || '',
          name: d.name || '',
          patronymic: d.patronymic || '',
          birth_date: d.birth_date || '',
        },
        candidates: [],
        note: d.note || '',
        restored: true,
      });
      localStorage.removeItem(PII_DRAFT_KEY);
    } catch (e) {}
  }

  /* Поиск персон — серверный */
  let piiSearchTimer = null;
  if (piiSearch) {
    piiSearch.addEventListener('input', () => {
      clearTimeout(piiSearchTimer);
      piiSearchTimer = setTimeout(() => loadPersons(piiSearch.value), 250);
    });
  }

  async function loadPersons(q) {
    if (!piiList) return;
    piiList.innerHTML = '<div class="kb-loader">Загрузка…</div>';
    try {
      const url = q && q.trim() ? `/api/pii/persons?q=${encodeURIComponent(q.trim())}` : '/api/pii/persons';
      const resp = await fetch(url);
      if (resp.status === 401) {
        piiLocked.style.display = 'block';
        piiUnlocked.style.display = 'none';
        return;
      }
      const data = await resp.json();
      renderPersons(data.items || []);
    } catch (err) {
      piiList.innerHTML = '<div class="kb-empty">Ошибка загрузки</div>';
    }
  }

  function personInitials(p) {
    const a = (p.surname || '').slice(0, 1).toUpperCase();
    const b = (p.name || '').slice(0, 1).toUpperCase();
    return a + b;
  }

  function renderPersons(items) {
    if (!items.length) {
      piiList.innerHTML = '<div class="kb-empty">Сотрудники не найдены. Создайте карточку или загрузите документ.</div>';
      return;
    }
    piiList.innerHTML = items.map((p) => {
      const dobLine = p.birth_date ? ` • д.р. ${new Date(p.birth_date).toLocaleDateString('ru-RU')}` : '';
      return `
      <div class="kb-person-group" data-person-id="${p.id}">
        <div class="kb-person-header">
          <div class="kb-person-icon">${escapeHtml(personInitials(p))}</div>
          <div class="kb-person-name">${escapeHtml(p.full_name_with_dob || p.full_name)}</div>
          <div class="kb-person-meta">${p.documents_count} документ(ов)${dobLine}</div>
          <i class="fas fa-chevron-right kb-person-chevron"></i>
        </div>
        <div class="kb-person-body" data-person-body></div>
      </div>`;
    }).join('');

    piiList.querySelectorAll('.kb-person-group').forEach((g) => {
      g.querySelector('.kb-person-header').addEventListener('click', async () => {
        const opening = !g.classList.contains('open');
        g.classList.toggle('open');
        if (opening) {
          const body = g.querySelector('[data-person-body]');
          body.innerHTML = '<div class="kb-loader">Загрузка…</div>';
          try {
            const resp = await fetch(`/api/pii/persons/${g.dataset.personId}`);
            const data = await resp.json();
            renderPersonBody(g, data.person);
          } catch (e) { body.innerHTML = '<div class="kb-empty">Ошибка</div>'; }
        }
      });
    });
  }

  function renderPersonBody(group, person) {
    const body = group.querySelector('[data-person-body]');
    const docs = person.documents || [];
    body.innerHTML = `
      ${docs.length ? docs.map((d) => `
        <div class="kb-pii-doc" data-doc-id="${d.id}">
          <div class="kb-pii-doc-icon"><i class="fas fa-file"></i></div>
          <div class="kb-pii-doc-name">${escapeHtml(d.filename)}</div>
          <div class="kb-pii-doc-meta">${Math.round((d.size_bytes || 0)/1024)} KB</div>
          <a class="kb-icon-btn kb-icon-btn-open" href="/api/pii/documents/${d.id}/download" target="_blank" title="Скачать"><i class="fas fa-download"></i></a>
          <button class="kb-icon-btn kb-icon-btn-danger" data-pii-doc-del="${d.id}" title="Удалить"><i class="fas fa-trash"></i></button>
        </div>
      `).join('') : '<div class="kb-empty" style="padding:16px;">Документов пока нет</div>'}
      <div class="kb-pii-add-doc">
        <label class="kb-pii-add-doc-btn">
          <i class="fas fa-plus"></i> Добавить документ
          <input type="file" hidden data-add-doc-for="${person.id}" accept=".pdf,.docx,.doc,.txt,.md,.jpg,.jpeg,.png">
        </label>
        <span style="font-size:12px;color:var(--text-secondary);flex:1;">Файл загружается без анализа в эту карточку.</span>
        <button class="kb-pii-delete-person" type="button" data-delete-person="${person.id}" title="Удалить карточку и все её документы">
          <i class="fas fa-trash"></i> Удалить карточку
        </button>
      </div>
    `;

    body.querySelectorAll('[data-pii-doc-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить документ?')) return;
        await fetch(`/api/pii/documents/${btn.dataset.piiDocDel}`, { method: 'DELETE' });
        const resp = await fetch(`/api/pii/persons/${person.id}`);
        const data = await resp.json();
        renderPersonBody(group, data.person);
      });
    });
    body.querySelectorAll('[data-add-doc-for]').forEach((input) => {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const form = new FormData();
        form.append('file', file);
        const resp = await fetch(`/api/pii/persons/${person.id}/documents`, { method: 'POST', body: form });
        if (resp.ok) {
          const r2 = await fetch(`/api/pii/persons/${person.id}`);
          const d2 = await r2.json();
          renderPersonBody(group, d2.person);
        } else {
          const err = await resp.json().catch(() => ({}));
          alert('Ошибка: ' + (err.detail || ''));
        }
        e.target.value = '';
      });
    });
    body.querySelectorAll('[data-delete-person]').forEach((btn) => {
      btn.addEventListener('click', () => openDeletePersonModal(person));
    });
  }

  /* === Удаление карточки (двойная защита) === */
  function openDeletePersonModal(person) {
    const modal      = document.getElementById('kbDeletePersonModal');
    const nameEl     = document.getElementById('kbDPName');
    const docsEl     = document.getElementById('kbDPDocs');
    const input      = document.getElementById('kbDPConfirmInput');
    const submit     = document.getElementById('kbDPSubmit');
    const hint       = document.getElementById('kbDPHint');

    const expected = (person.full_name || `${person.surname} ${person.name} ${person.patronymic || ''}`).trim();
    const docsCount = (person.documents && person.documents.length) || person.documents_count || 0;

    nameEl.textContent = expected;
    docsEl.textContent = String(docsCount);
    input.value = '';
    submit.disabled = true;
    hint.textContent = 'Кнопка активируется при совпадении';
    hint.classList.remove('ok');

    const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const expectedNorm = normalize(expected);

    // Отлавливаем «нечестные» способы ввода (paste, drop, autofill).
    // Принимаем только обычный набор и backspace/delete.
    const ALLOWED_INPUT_TYPES = new Set([
      'insertText',
      'insertCompositionText',
      'deleteContentBackward',
      'deleteContentForward',
      'deleteWordBackward',
      'deleteWordForward',
      'historyUndo',
      'historyRedo',
    ]);
    function onInput(ev) {
      if (ev && ev.inputType && !ALLOWED_INPUT_TYPES.has(ev.inputType)) {
        // Сбрасываем содержимое — пользователь вставил из буфера или drag&drop
        input.value = '';
        hint.textContent = 'Поле очищено — ФИО нужно ввести вручную.';
        hint.classList.remove('ok');
        submit.disabled = true;
        return;
      }
      const ok = normalize(input.value) === expectedNorm;
      submit.disabled = !ok;
      hint.textContent = ok
        ? 'Совпадает — можно подтверждать'
        : 'Кнопка активируется при совпадении. Вставка из буфера обмена отключена.';
      hint.classList.toggle('ok', ok);
    }
    input.removeEventListener('input', input.__dpHandler || (() => {}));
    input.__dpHandler = onInput;
    input.addEventListener('input', onInput);

    async function doDelete() {
      // Второй уровень защиты — нативный confirm с явным OK
      if (!confirm(`Окончательно удалить «${expected}» и ${docsCount} док.? Действие необратимо.`)) {
        return;
      }
      submit.disabled = true;
      submit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Удаление…';
      try {
        const resp = await fetch(`/api/pii/persons/${person.id}`, { method: 'DELETE' });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          alert('Не удалось удалить: ' + (err.detail || resp.status));
          submit.disabled = false;
          submit.innerHTML = '<i class="fas fa-trash"></i> Удалить навсегда';
          return;
        }
        closeDeletePersonModal();
        loadPersons(piiSearch ? piiSearch.value : '');
      } catch (e) {
        alert('Ошибка соединения: ' + e.message);
        submit.disabled = false;
        submit.innerHTML = '<i class="fas fa-trash"></i> Удалить навсегда';
      }
    }
    submit.onclick = doDelete;

    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 50);
  }

  function closeDeletePersonModal() {
    const modal = document.getElementById('kbDeletePersonModal');
    if (modal) modal.style.display = 'none';
  }
  document.getElementById('kbDeletePersonClose')?.addEventListener('click', closeDeletePersonModal);
  document.getElementById('kbDPCancel')?.addEventListener('click', closeDeletePersonModal);
  document.getElementById('kbDeletePersonModal')?.querySelector('.kb-modal-overlay')?.addEventListener('click', closeDeletePersonModal);

  /* Импорт сотрудников из таблицы 1С (CSV/XLSX) — #18 */
  const pii1cFile = document.getElementById('kbPii1cFile');
  if (pii1cFile) {
    pii1cFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      piiStatus.style.display = 'block';
      piiStatus.className = 'kb-upload-status';
      piiStatusText.textContent = `Импорт сотрудников из «${file.name}»…`;
      const form = new FormData();
      form.append('file', file);
      try {
        const resp = await fetch('/api/pii/import/1c', { method: 'POST', body: form });
        if (resp.status === 401) {
          piiStatus.style.display = 'none';
          alert('Сессия ПДн истекла, введите пароль заново.');
          return;
        }
        const data = await resp.json();
        if (resp.ok && data.success) {
          piiStatus.className = 'kb-upload-status success';
          piiStatusText.textContent = `Добавлено сотрудников: ${data.created}, пропущено (дубли/без ФИО): ${data.skipped}.`;
          loadPersons(piiSearch ? piiSearch.value : '');
          setTimeout(() => { piiStatus.style.display = 'none'; }, 5000);
        } else {
          piiStatus.className = 'kb-upload-status error';
          piiStatusText.textContent = `Ошибка: ${data.detail || data.error || '?'}`;
        }
      } catch (err) {
        piiStatus.className = 'kb-upload-status error';
        piiStatusText.textContent = `Ошибка соединения: ${err.message}`;
      } finally {
        pii1cFile.value = '';
      }
    });
  }

  /* Быстрая загрузка */
  const quickFile = document.getElementById('kbPiiQuickFile');
  if (quickFile) {
    quickFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      piiStatus.style.display = 'block';
      piiStatus.className = 'kb-upload-status';
      piiStatusText.textContent = `Распознавание «${file.name}»…`;
      const form = new FormData();
      form.append('file', file);
      try {
        const resp = await fetch('/api/pii/upload/quick-analyze', { method: 'POST', body: form });
        if (resp.status === 401) {
          piiStatus.style.display = 'none';
          alert('Сессия истекла, введите пароль заново.');
          piiLocked.style.display = 'block';
          piiUnlocked.style.display = 'none';
          return;
        }
        const data = await resp.json();
        if (!resp.ok) {
          piiStatus.className = 'kb-upload-status error';
          piiStatusText.textContent = `Ошибка: ${data.detail || '?'}`;
          return;
        }
        piiStatus.style.display = 'none';
        openQuickModal(data, file);
      } catch (err) {
        piiStatus.className = 'kb-upload-status error';
        piiStatusText.textContent = `Ошибка: ${err.message}`;
      } finally {
        quickFile.value = '';
      }
    });
  }

  let _pendingQuickFile = null;
  function openQuickModal(data, file) {
    _pendingQuickFile = file || null;
    const modal = document.getElementById('kbQuickConfirmModal');
    document.getElementById('kbQuickFileName').textContent = (data.filename || data.recognized?.filename || '') + (data.restored ? ' (восстановлено)' : '');
    document.getElementById('kbQ_surname').value    = data.recognized?.surname    || '';
    document.getElementById('kbQ_name').value       = data.recognized?.name       || '';
    document.getElementById('kbQ_patronymic').value = data.recognized?.patronymic || '';
    document.getElementById('kbQ_birth_date').value = data.recognized?.birth_date ? new Date(data.recognized.birth_date).toLocaleDateString('ru-RU') : '';
    document.getElementById('kbQ_note').value       = data.note || '';

    const candWrap = document.getElementById('kbQ_candidates');
    const candList = document.getElementById('kbQ_candidates_list');
    if (data.candidates && data.candidates.length) {
      candList.innerHTML = data.candidates.map((c) => `
        <div class="kb-candidate" data-cand-id="${c.id}">
          <span>${escapeHtml(c.full_name_with_dob || c.full_name)} • ${c.documents_count} док.</span>
          <button data-pick-cand="${c.id}">Загрузить в эту карточку</button>
        </div>
      `).join('');
      candWrap.style.display = '';
      candList.querySelectorAll('[data-pick-cand]').forEach((b) => {
        b.addEventListener('click', () => submitQuick(Number(b.dataset.pickCand)));
      });
    } else {
      candWrap.style.display = 'none';
    }
    modal.style.display = 'flex';
  }

  function closeQuickModal() {
    document.getElementById('kbQuickConfirmModal').style.display = 'none';
    _pendingQuickFile = null;
  }
  document.getElementById('kbQuickConfirmClose')?.addEventListener('click', closeQuickModal);
  document.getElementById('kbQ_cancel')?.addEventListener('click', closeQuickModal);
  document.getElementById('kbQ_submit')?.addEventListener('click', () => submitQuick(null));

  async function submitQuick(personId) {
    if (!_pendingQuickFile) {
      alert('Файл утрачен (вероятно, после восстановления). Выберите файл заново.');
      closeQuickModal();
      return;
    }
    const form = new FormData();
    form.append('file', _pendingQuickFile);
    if (personId) {
      form.append('person_id', personId);
    } else {
      form.append('surname',    document.getElementById('kbQ_surname').value.trim());
      form.append('name',       document.getElementById('kbQ_name').value.trim());
      const pat = document.getElementById('kbQ_patronymic').value.trim();
      if (pat) form.append('patronymic', pat);
      const bd = document.getElementById('kbQ_birth_date').value.trim();
      if (bd) form.append('birth_date', bd);
    }
    const note = document.getElementById('kbQ_note').value.trim();
    if (note) form.append('note', note);

    try {
      const resp = await fetch('/api/pii/upload/commit', { method: 'POST', body: form });
      const data = await resp.json();
      if (!resp.ok) { alert('Ошибка: ' + (data.detail || '')); return; }
      closeQuickModal();
      loadPersons(piiSearch ? piiSearch.value : '');
    } catch (e) { alert('Ошибка: ' + e.message); }
  }

  /* Создать карточку вручную */
  document.getElementById('kbPiiAddPersonBtn')?.addEventListener('click', () => {
    document.getElementById('kbNewPersonModal').style.display = 'flex';
  });
  const closeNewPerson = () => { document.getElementById('kbNewPersonModal').style.display = 'none'; };
  document.getElementById('kbNewPersonClose')?.addEventListener('click', closeNewPerson);
  document.getElementById('kbNP_cancel')?.addEventListener('click', closeNewPerson);
  document.getElementById('kbNP_submit')?.addEventListener('click', async () => {
    const body = {
      surname:    document.getElementById('kbNP_surname').value.trim(),
      name:       document.getElementById('kbNP_name').value.trim(),
      patronymic: document.getElementById('kbNP_patronymic').value.trim() || null,
      birth_date: document.getElementById('kbNP_birth_date').value.trim() || null,
    };
    if (!body.surname || !body.name) { alert('Фамилия и имя обязательны'); return; }
    const resp = await fetch('/api/pii/persons', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) { alert('Ошибка: ' + (data.detail || '')); return; }
    closeNewPerson();
    loadPersons('');
  });

  /* ============ FAQ (А2/А6): курируемые вопросы-ответы ============ */
  const faqList = document.getElementById('kbFaqList');

  async function loadFaq() {
    if (!faqList) return;
    faqList.innerHTML = '<div class="kb-loader">Загрузка…</div>';
    try {
      const resp = await fetch('/api/kb/faq');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || '');
      renderFaq(data.items || []);
    } catch (err) {
      faqList.innerHTML = '<div class="kb-empty">Ошибка загрузки FAQ</div>';
    }
    if (document.getElementById('kbUsersList')) loadKbUsers();
  }

  function faqCard(e) {
    const variants = (e.variants || []).map((v) => `<span class="kb-tag">${escapeHtml(v)}</span>`).join(' ');
    const sub = e.option_label
      ? `<span class="kb-faq-branch"><i class="fas fa-code-branch"></i> ${escapeHtml(e.option_label)}</span>` : '';
    const clarify = e.clarify_question
      ? `<div class="kb-faq-row"><i class="fas fa-circle-question"></i> Уточняющий вопрос: ${escapeHtml(e.clarify_question)}</div>` : '';
    const docs = (e.doc_refs && e.doc_refs.length)
      ? `<div class="kb-faq-row"><i class="fas fa-link"></i> ${escapeHtml(e.doc_refs.join('; '))}</div>` : '';
    const contact = e.contact
      ? `<div class="kb-faq-row"><i class="fas fa-user-tie"></i> ${escapeHtml(e.contact)}</div>` : '';
    const answerShort = (e.answer || '').length > 220 ? e.answer.slice(0, 220) + '…' : (e.answer || '');
    return `
    <div class="kb-item kb-faq-item ${e.is_active ? '' : 'kb-faq-inactive'}" data-faq-id="${e.id}">
      <div class="kb-item-icon source"><i class="fas fa-comments"></i></div>
      <div class="kb-item-body">
        <div class="kb-item-title">${escapeHtml(e.block || '(без блока)')} ${sub}
          <span class="kb-item-badge">${escapeHtml(e.source_file || '')}</span>
        </div>
        <div class="kb-faq-variants">${variants}</div>
        ${clarify}
        <div class="kb-faq-answer" data-full="${escapeAttr(e.answer || '')}">${escapeHtml(answerShort)}</div>
        ${docs}${contact}
      </div>
      <div class="kb-item-actions">
        <button class="kb-icon-btn" data-faq-edit="${e.id}" title="Редактировать"><i class="fas fa-pen"></i></button>
        <button class="kb-icon-btn" data-faq-toggle="${e.id}" title="${e.is_active ? 'Выключить (не участвует в ответах)' : 'Включить'}">
          <i class="fas ${e.is_active ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
        </button>
        <button class="kb-icon-btn kb-icon-btn-danger" data-faq-del="${e.id}" title="Удалить"><i class="fas fa-trash"></i></button>
      </div>
    </div>`;
  }

  let faqItems = [];
  function renderFaq(items) {
    faqItems = items;
    if (!items.length) {
      faqList.innerHTML = '<div class="kb-empty">FAQ пуст — импортируйте файлы «чат-бот …».</div>';
      return;
    }
    faqList.innerHTML = items.map(faqCard).join('');
  }

  faqList?.addEventListener('click', async (ev) => {
    const editBtn = ev.target.closest('[data-faq-edit]');
    const toggleBtn = ev.target.closest('[data-faq-toggle]');
    const delBtn = ev.target.closest('[data-faq-del]');
    if (toggleBtn) {
      const id = Number(toggleBtn.dataset.faqToggle);
      const item = faqItems.find((x) => x.id === id);
      await fetch(`/api/kb/faq/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !(item && item.is_active) }),
      });
      loadFaq();
      return;
    }
    if (delBtn) {
      const id = Number(delBtn.dataset.faqDel);
      if (!confirm('Удалить FAQ-запись? Ответы бота перестанут её использовать.')) return;
      await fetch(`/api/kb/faq/${id}`, { method: 'DELETE' });
      loadFaq();
      return;
    }
    if (editBtn) {
      const id = Number(editBtn.dataset.faqEdit);
      const item = faqItems.find((x) => x.id === id);
      if (!item) return;
      openFaqEditor(item);
    }
  });

  // Инлайн-редактор: варианты (по строке), уточняющий вопрос, ответ, контакт.
  function openFaqEditor(item) {
    const card = faqList.querySelector(`[data-faq-id="${item.id}"]`);
    if (!card || card.querySelector('.kb-faq-editor')) return;
    const box = document.createElement('div');
    box.className = 'kb-faq-editor';
    box.innerHTML = `
      <label>Варианты запросов (по одному в строке)
        <textarea class="kbF_variants" rows="3">${escapeHtml((item.variants || []).join('\n'))}</textarea></label>
      <label>Уточняющий вопрос (для ветвящихся блоков)
        <input class="kbF_clarify" type="text" value="${escapeAttr(item.clarify_question || '')}"></label>
      <label>Метка под-ветки
        <input class="kbF_option" type="text" value="${escapeAttr(item.option_label || '')}"></label>
      <label>Ответ
        <textarea class="kbF_answer" rows="6">${escapeHtml(item.answer || '')}</textarea></label>
      <label>Контактное лицо / подразделение
        <input class="kbF_contact" type="text" value="${escapeAttr(item.contact || '')}"></label>
      <div class="kb-modal-actions">
        <button class="kb-btn-secondary kbF_cancel" type="button">Отмена</button>
        <button class="kb-btn-primary kbF_save" type="button"><i class="fas fa-save"></i> Сохранить</button>
      </div>`;
    card.querySelector('.kb-item-body').appendChild(box);
    box.querySelector('.kbF_cancel').addEventListener('click', () => box.remove());
    box.querySelector('.kbF_save').addEventListener('click', async () => {
      const body = {
        variants: box.querySelector('.kbF_variants').value.split('\n').map((s) => s.trim()).filter(Boolean),
        clarify_question: box.querySelector('.kbF_clarify').value.trim(),
        option_label: box.querySelector('.kbF_option').value.trim(),
        answer: box.querySelector('.kbF_answer').value,
        contact: box.querySelector('.kbF_contact').value.trim(),
      };
      const resp = await fetch(`/api/kb/faq/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!resp.ok) { const d = await resp.json(); alert('Ошибка: ' + (d.detail || '')); return; }
      loadFaq();
    });
  }

  document.getElementById('kbFaqSearch')?.addEventListener('input', (e) => {
    filterCards(faqList, e.target.value, '.kb-faq-item');
  });

  // Полный реимпорт из выбранных файлов
  document.getElementById('kbFaqImportInput')?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    if (!confirm(`Импорт ${files.length} файл(ов) ЗАМЕНИТ все FAQ-записи, включая ручные правки. Продолжить?`)) {
      e.target.value = '';
      return;
    }
    const statusBox = document.getElementById('kbFaqStatus');
    const statusTxt = document.getElementById('kbFaqStatusText');
    statusBox.style.display = '';
    statusTxt.textContent = 'Импортирую…';
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    try {
      const resp = await fetch('/api/kb/faq/import', { method: 'POST', body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || '');
      statusTxt.textContent = `Импортировано: ${data.groups} блоков, ${data.entries} записей`;
      loadFaq();
    } catch (err) {
      statusTxt.textContent = 'Ошибка: ' + err.message;
    } finally {
      e.target.value = '';
      setTimeout(() => { statusBox.style.display = 'none'; }, 6000);
    }
  });

  /* Доступы (только админ): чекбокс «редактор БЗ» по пользователям */
  async function loadKbUsers() {
    const box = document.getElementById('kbUsersList');
    if (!box) return;
    try {
      const resp = await fetch('/api/kb/users');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || '');
      box.innerHTML = (data.items || []).map((u) => `
        <div class="kb-item kb-user-item">
          <div class="kb-item-icon source"><i class="fas fa-user"></i></div>
          <div class="kb-item-body">
            <div class="kb-item-title">${escapeHtml(u.full_name)} <span class="kb-item-badge">${escapeHtml(u.position || '')}</span></div>
            <div class="kb-item-meta">@${escapeHtml(u.username)}${u.is_admin ? ' • администратор' : ''}</div>
          </div>
          <label class="kb-user-role">
            <input type="checkbox" data-user-editor="${u.id}" ${u.is_kb_editor || u.is_admin ? 'checked' : ''} ${u.is_admin ? 'disabled' : ''}>
            редактор БЗ
          </label>
        </div>`).join('');
      box.querySelectorAll('[data-user-editor]').forEach((cb) => {
        cb.addEventListener('change', async () => {
          const resp2 = await fetch(`/api/kb/users/${cb.dataset.userEditor}/roles`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_kb_editor: cb.checked }),
          });
          if (!resp2.ok) { cb.checked = !cb.checked; alert('Не удалось изменить роль'); }
        });
      });
    } catch (err) {
      box.innerHTML = '<div class="kb-empty">Ошибка загрузки пользователей</div>';
    }
  }

  /* Стартуем */
  loadDocs();
});
