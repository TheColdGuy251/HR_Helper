document.addEventListener('DOMContentLoaded', function () {
  const tbody     = document.getElementById('auditTbody');
  const actionSel = document.getElementById('auditAction');
  const userIdIn  = document.getElementById('auditUserId');
  const reload    = document.getElementById('auditReload');
  const prev      = document.getElementById('auditPrev');
  const next      = document.getElementById('auditNext');
  const info      = document.getElementById('auditPageInfo');

  const PAGE = 50;
  let offset = 0;
  let total = 0;

  const ACTION_LABELS = {
    reauth_ok: 'Вход',
    reauth_fail: 'Ошибка входа',
    view_person: 'Просмотр',
    create_person: 'Создание карточки',
    delete_person: 'Удаление карточки',
    upload: 'Загрузка',
    download: 'Скачивание',
    delete: 'Удаление',
    quick_analyze: 'Анализ файла',
  };

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
    } catch (e) { return iso; }
  }

  async function load() {
    tbody.innerHTML = '<tr><td colspan="5" class="audit-loader">Загрузка…</td></tr>';
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (actionSel.value) params.set('action', actionSel.value);
    if (userIdIn.value && /^\d+$/.test(userIdIn.value.trim())) params.set('user_id', userIdIn.value.trim());
    try {
      const resp = await fetch('/api/audit/pii?' + params.toString());
      const data = await resp.json();
      total = data.total || 0;
      render(data.items || []);
      updatePager();
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="5" class="audit-empty">Ошибка загрузки</td></tr>';
    }
  }

  function render(items) {
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="audit-empty">Записей не найдено</td></tr>';
      return;
    }
    tbody.innerHTML = items.map((r) => {
      const userCell = r.user_id
        ? `<div class="audit-user">${window.escapeHtml(r.user_name || '—')}</div>
           <div class="audit-user-email">${window.escapeHtml(r.user_email || '')} (#${r.user_id})</div>`
        : '<span class="audit-user-email">—</span>';
      const label = ACTION_LABELS[r.action] || r.action;
      const entityCell = r.entity
        ? `<span class="audit-entity"><strong>${window.escapeHtml(r.entity)}</strong>${r.entity_id ? ' #' + r.entity_id : ''}</span>`
        : '';
      const extraCell = r.extra
        ? `<span class="audit-extra" title='${window.escapeAttr(JSON.stringify(r.extra))}'>${window.escapeHtml(JSON.stringify(r.extra))}</span>`
        : '';
      return `
        <tr>
          <td><span class="audit-time">${fmtTime(r.at)}</span></td>
          <td>${userCell}</td>
          <td><span class="audit-action-tag audit-act-${window.escapeAttr(r.action)}">${window.escapeHtml(label)}</span></td>
          <td>${entityCell}</td>
          <td>${extraCell}</td>
        </tr>`;
    }).join('');
  }

  function updatePager() {
    const from = total === 0 ? 0 : offset + 1;
    const to = Math.min(offset + PAGE, total);
    info.textContent = total ? `${from}–${to} из ${total}` : 'нет данных';
    prev.disabled = offset <= 0;
    next.disabled = offset + PAGE >= total;
  }

  // Заменяем нативный select на кастомный (если util-функция доступна)
  if (window.makeCustomSelect) window.makeCustomSelect(actionSel);

  reload.addEventListener('click', () => { offset = 0; load(); });
  actionSel.addEventListener('change', () => { offset = 0; load(); });
  userIdIn.addEventListener('change', () => { offset = 0; load(); });
  prev.addEventListener('click', () => { offset = Math.max(0, offset - PAGE); load(); });
  next.addEventListener('click', () => { offset += PAGE; load(); });

  load();
});
