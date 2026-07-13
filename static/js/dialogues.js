document.addEventListener('DOMContentLoaded', function () {
  const createDialogueBtn = document.getElementById('createDialogueBtn');
  const filterButtons = document.querySelectorAll('.filter-btn');
  const dialoguesList = document.getElementById('dialoguesList');
  const pagination = document.getElementById('dialoguesPagination');
  const statsContainer = document.getElementById('statsContainer');
  const dialogueSearch = document.getElementById('dialogueSearch');

  const PAGE_SIZE = 20;       // диалогов на странице
  let currentPage = 1;
  let totalPages = 0;
  let currentFilter = 'active';
  let searchQuery = '';
  let searchTimer = null;

  loadDialogues();

  // Если пришли с параметром ?open_dialogue=1 — сразу создаём диалог,
  // а старый параметр чистим, чтобы при F5 не повторялось.
  (function () {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('open_dialogue') === '1') {
        const url = new URL(window.location);
        url.searchParams.delete('open_dialogue');
        window.history.replaceState({}, '', url);
        setTimeout(createDialogueQuickly, 0);
      }
    } catch (e) { console.error(e); }
  })();

  // Создание диалога одним кликом — без модалки.
  async function createDialogueQuickly() {
    try {
      const resp = await fetch('/api/dialogues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await resp.json();
      if (resp.ok && data.success && data.session_id) {
        window.location.href = `/chat/${data.session_id}`;
      } else {
        alert('Не удалось создать диалог');
      }
    } catch (e) {
      alert('Ошибка соединения: ' + e.message);
    }
  }
  if (createDialogueBtn) {
    createDialogueBtn.addEventListener('click', createDialogueQuickly);
  }

  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      filterButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      currentPage = 1;
      loadDialogues();
    });
  });

  let lastDlgSig = null;
  function dlgSig(items, stats) {
    return currentFilter + '||' + currentPage + '/' + totalPages + '||' +
      items.map((d) => `${d.id}:${d.title}:${d.unread ? 1 : 0}:${d.is_finished ? 1 : 0}:${(d.last_message && d.last_message.text) || ''}`).join('|') +
      '||' + JSON.stringify(stats || {});
  }

  async function loadDialogues(force = true) {
    if (!dialoguesList) return;
    try {
      const params = new URLSearchParams({
        filter: currentFilter,
        page: String(currentPage),
        page_size: String(PAGE_SIZE),
      });
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      const resp = await fetch(`/api/dialogues?${params.toString()}`);
      const data = await resp.json();
      if (data.success) {
        // Сервер мог склампить страницу (например, после удаления)
        currentPage = data.page || currentPage;
        totalPages = data.total_pages || 0;
        const items = data.items || [];
        // Авто-обновление без мигания: перерисовываем только при изменениях
        const sig = dlgSig(items, data.stats);
        if (force || sig !== lastDlgSig) {
          lastDlgSig = sig;
          renderDialogues(items);
          renderStats(data.stats);
        }
      } else if (force) {
        dialoguesList.innerHTML = '<div class="error-message">Ошибка загрузки</div>';
      }
    } catch (err) {
      if (force) dialoguesList.innerHTML = '<div class="error-message">Ошибка подключения</div>';
    }
  }

  // Обновление по push-событиям (SSE, #16); фолбэк редкий и только при видимой
  // вкладке; при возврате на вкладку — одна синхронизация.
  window.addEventListener('hr:dialogues-changed', () => loadDialogues(false));
  setInterval(() => { if (!document.hidden) loadDialogues(false); }, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadDialogues(false); });

  if (dialogueSearch) {
    dialogueSearch.addEventListener('input', () => {
      searchQuery = dialogueSearch.value || '';
      currentPage = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadDialogues(true), 250);
    });
  }

  function renderPagination() {
    if (!pagination) return;
    if (totalPages <= 1) { pagination.innerHTML = ''; return; }

    const btn = (page, label, opts = {}) => {
      const cls = ['page-btn'];
      if (opts.active) cls.push('active');
      if (opts.disabled) cls.push('disabled');
      const attr = opts.disabled ? ' disabled' : ` data-page="${page}"`;
      return `<button class="${cls.join(' ')}" type="button"${attr}>${label}</button>`;
    };

    // Окно номеров страниц вокруг текущей
    const pages = [];
    const win = 2;
    let from = Math.max(1, currentPage - win);
    let to = Math.min(totalPages, currentPage + win);
    if (from > 1) { pages.push(1); if (from > 2) pages.push('…'); }
    for (let p = from; p <= to; p++) pages.push(p);
    if (to < totalPages) { if (to < totalPages - 1) pages.push('…'); pages.push(totalPages); }

    let html = btn(currentPage - 1, '<i class="fas fa-chevron-left"></i>', { disabled: currentPage === 1 });
    html += pages.map((p) => p === '…'
      ? '<span class="page-ellipsis">…</span>'
      : btn(p, p, { active: p === currentPage })).join('');
    html += btn(currentPage + 1, '<i class="fas fa-chevron-right"></i>', { disabled: currentPage === totalPages });
    pagination.innerHTML = html;

    pagination.querySelectorAll('.page-btn[data-page]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = parseInt(b.dataset.page, 10);
        if (p === currentPage) return;
        currentPage = p;
        loadDialogues(true);
        if (dialoguesList) dialoguesList.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  // Время последнего сообщения: сегодня → «HH:MM», раньше → «DD/MM/YYYY HH:MM».
  function formatDlgTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    return sameDay ? hm : `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${hm}`;
  }

  function renderDialogues(items) {
    if (!dialoguesList) return;
    if (!items.length) {
      dialoguesList.innerHTML = `<div class="no-dialogues">${searchQuery ? 'Ничего не найдено' : 'Нет диалогов'}</div>`;
      renderPagination();
      return;
    }
    dialoguesList.innerHTML = items.map(d => {
      const lm = d.last_message;
      const lmTime = lm && lm.ts ? formatDlgTime(lm.ts) : '';
      // Статус прочтения (как в мессенджерах): одна синяя галочка — ответ не просмотрен,
      // двойная — просмотрен.
      const readIcon = d.unread
        ? '<i class="fas fa-check dip-check dip-check-unread" title="Не просмотрено"></i>'
        : '<i class="fas fa-check-double dip-check dip-check-read" title="Просмотрено"></i>';
      const timeHtml = lmTime ? `<div class="dialogue-item-time">${readIcon} ${escapeHtml(lmTime)}</div>` : '';
      const preview = lm
        ? `<div class="dialogue-item-preview"><span class="dip-role">${lm.role === 'user' ? 'Вы' : 'Ассистент'}:</span> ${escapeHtml(lm.text)}</div>`
        : (d.description ? `<div class="dialogue-item-description">${escapeHtml(d.description)}</div>` : '<div class="dialogue-item-preview muted">Нет сообщений</div>');
      const unreadDot = d.unread ? '<span class="dialogue-unread-dot" title="Есть непрочитанный ответ"></span>' : '';
      return `
      <div class="dialogue-item${d.unread ? ' has-unread' : ''}" data-dialogue-id="${d.id}" onclick="openChatForDialogue('${escapeAttr(d.session_id || '')}')">
        <div class="dialogue-item-header">
          <div class="dialogue-item-title">${unreadDot}${escapeHtml(d.title)}</div>
          <div class="dialogue-item-status ${d.is_finished ? 'finished' : 'active'}">
            ${d.is_finished ? 'Завершён' : 'Активен'}
          </div>
        </div>
        ${preview}
        ${timeHtml}
        <div class="dialogue-actions">
          <button class="dialogue-action-btn ${d.is_finished ? 'primary' : ''}" onclick="toggleDialogue(${d.id}, ${d.is_finished}); event.stopPropagation()">
            <i class="fas ${d.is_finished ? 'fa-undo' : 'fa-check'}"></i>
            ${d.is_finished ? 'Вернуть' : 'Завершить'}
          </button>
          <button class="dialogue-action-btn danger" onclick="deleteDialogue(${d.id}); event.stopPropagation()">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
    }).join('');
    renderPagination();
  }

  function renderStats(stats) {
    if (!statsContainer || !stats) return;
    statsContainer.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value">${stats.active}</div><div class="stat-label">Активных</div></div>
        <div class="stat-card"><div class="stat-value">${stats.finished}</div><div class="stat-label">Решённых</div></div>
        <div class="stat-card"><div class="stat-value">${stats.total}</div><div class="stat-label">Всего</div></div>
      </div>`;
  }

  function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }
  function escapeAttr(s) { return String(s || '').replace(/"/g, '&quot;'); }

  window.toggleDialogue = async function (id, isFinished) {
    const url = isFinished
      ? `/api/dialogues/${id}/reopen`
      : `/api/dialogues/${id}/finish`;
    try {
      const resp = await fetch(url, { method: 'POST' });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert('Ошибка: ' + (err.detail || resp.status));
        return;
      }
      loadDialogues();
    } catch (e) {
      console.error(e);
      alert('Ошибка соединения: ' + e.message);
    }
  };

  window.deleteDialogue = async function (id) {
    if (!confirm('Удалить диалог?')) return;
    try {
      await fetch(`/api/dialogues/${id}`, { method: 'DELETE' });
      loadDialogues();
    } catch (e) { console.error(e); }
  };

  window.openChatForDialogue = function (sessionId) {
    if (!sessionId) return;
    window.location.href = `/chat/${sessionId}`;
  };
});
