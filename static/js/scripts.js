/* scripts.js — глобальная логика: модалка профиля, выход, аватары, утилиты. */

/* ============== Общие утилиты ============== */
window.escapeHtml = function (text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
};

window.escapeAttr = function (s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

window.debounce = function (fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
};

/* Превращает <select> в кастомный дропдаун в едином стиле проекта.
   Скрытый <select> остаётся в DOM, чтобы форма продолжала отправляться нормально.
   Возвращает API { refresh, destroy } для повторной синхронизации со списком options. */
window.makeCustomSelect = function (selectEl) {
  if (!selectEl || selectEl.dataset.cselectInit === '1') return null;
  selectEl.dataset.cselectInit = '1';

  // Корневой wrapper — оборачиваем select.
  const root = document.createElement('div');
  root.className = 'cselect';
  if (selectEl.style.cssText) root.style.cssText = selectEl.style.cssText;
  selectEl.parentNode.insertBefore(root, selectEl);
  root.appendChild(selectEl);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cselect-trigger';

  const menu = document.createElement('div');
  menu.className = 'cselect-menu';

  root.appendChild(trigger);
  root.appendChild(menu);

  function close() {
    root.classList.remove('is-open');
    trigger.classList.remove('is-open');
    document.removeEventListener('click', onDocClick, true);
  }
  function open() {
    document.querySelectorAll('.cselect.is-open').forEach((el) => {
      if (el !== root) el.classList.remove('is-open');
    });
    root.classList.add('is-open');
    trigger.classList.add('is-open');
    document.addEventListener('click', onDocClick, true);
  }
  function onDocClick(e) {
    if (!root.contains(e.target)) close();
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    root.classList.contains('is-open') ? close() : open();
  });

  function refresh() {
    menu.innerHTML = '';
    const opts = Array.from(selectEl.options);
    // Опции с пустым value считаются placeholder'ом — они НЕ рисуются в menu,
    // их текст используется только для trigger, когда ничего не выбрано.
    const visible = opts.filter((o) => o.value !== '' && o.value != null);

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'cselect-empty';
      empty.textContent = 'Нет вариантов';
      menu.appendChild(empty);
      syncTrigger();
      return;
    }

    visible.forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'cselect-option';
      item.textContent = opt.textContent;
      if (opt.disabled) item.classList.add('is-disabled');
      if (opt.value === selectEl.value) item.classList.add('is-selected');
      item.addEventListener('mouseenter', () => {
        menu.querySelectorAll('.cselect-option').forEach((o) => o.classList.remove('is-active'));
        item.classList.add('is-active');
      });
      item.addEventListener('click', () => {
        if (opt.disabled) return;
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        menu.querySelectorAll('.cselect-option').forEach((o) => o.classList.remove('is-selected'));
        item.classList.add('is-selected');
        syncTrigger();
        close();
      });
      menu.appendChild(item);
    });
    syncTrigger();
  }

  function syncTrigger(placeholder) {
    const sel = selectEl.options[selectEl.selectedIndex];
    if (!sel) {
      trigger.textContent = '— выберите —';
      trigger.classList.add('is-placeholder');
      return;
    }
    trigger.textContent = sel.textContent || '—';
    const isEmptyVal = sel.value === '' || sel.value == null;
    trigger.classList.toggle('is-placeholder', isEmptyVal);
  }

  // Реагируем, если форма меняет select напрямую (например, .reset())
  selectEl.addEventListener('change', () => syncTrigger());

  // Наблюдаем за изменением списка <option> снаружи (когда JS подгружает варианты)
  const mo = new MutationObserver(() => refresh());
  mo.observe(selectEl, { childList: true, subtree: false });

  refresh();

  return {
    refresh,
    destroy: () => {
      mo.disconnect();
      root.replaceWith(selectEl);
      selectEl.dataset.cselectInit = '';
    },
  };
};


/* Простой toast (используется при logout и т.п.) */
window.showNotification = function (message, type) {
  let host = document.getElementById('__toast_host__');
  if (!host) {
    host = document.createElement('div');
    host.id = '__toast_host__';
    host.style.cssText = 'position:fixed;top:24px;right:24px;z-index:10000;display:flex;flex-direction:column;gap:10px;';
    document.body.appendChild(host);
  }
  const colors = {
    success: { bg: '#ecfdf5', bd: '#10b981', tx: '#065f46' },
    error:   { bg: '#fef2f2', bd: '#ef4444', tx: '#991b1b' },
    info:    { bg: '#eff6ff', bd: '#1e40af', tx: '#1e3a8a' },
  };
  const c = colors[type] || colors.info;
  const el = document.createElement('div');
  el.style.cssText = `background:${c.bg};border-left:4px solid ${c.bd};color:${c.tx};padding:12px 16px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.08);font-size:14px;max-width:340px;animation:fadeIn 0.2s ease;`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(10px)';
    setTimeout(() => el.remove(), 300);
  }, 3000);
};

/* ============== UI-логика страницы ============== */
document.addEventListener('DOMContentLoaded', function () {
  const profileButton = document.getElementById('profileButton');
  const profileModal = document.getElementById('profileModal');
  const backButton = document.getElementById('backButton');
  const logoutButton = document.getElementById('logoutButton');
  const myDialoguesButton = document.getElementById('myDialoguesButton');
  const newDialogueButton = document.getElementById('newDialogueButton');

  const closeProfileModal = () => profileModal && profileModal.classList.remove('active');

  if (profileButton && profileModal) {
    profileButton.addEventListener('click', () => profileModal.classList.add('active'));
  }
  if (backButton) backButton.addEventListener('click', closeProfileModal);

  // Единое закрытие модалок по клику вне контента (фон/оверлей).
  // Профиль показывается через класс .active, KB-модалки — через style.display.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.classList) return;
    if (t.id === 'profileModal') {
      t.classList.remove('active');
    } else if (t.classList.contains('kb-modal-overlay')) {
      const m = t.closest('.kb-modal');
      if (m) m.style.display = 'none';
    }
  });
  // Закрытие открытой модалки по Escape.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (profileModal && profileModal.classList.contains('active')) profileModal.classList.remove('active');
    document.querySelectorAll('.kb-modal').forEach((m) => {
      if (m.style.display && m.style.display !== 'none') m.style.display = 'none';
    });
  });

  if (myDialoguesButton) {
    myDialoguesButton.addEventListener('click', () => {
      closeProfileModal();
      window.location.href = '/dialogues';
    });
  }

  if (newDialogueButton) {
    newDialogueButton.addEventListener('click', () => {
      closeProfileModal();
      const btn = document.getElementById('createDialogueBtn');
      if (btn) {
        setTimeout(() => btn.click(), 150);
      } else {
        window.location.href = '/dialogues?open_dialogue=1';
      }
    });
  }

  if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
      if (!confirm('Вы уверены, что хотите выйти из системы?')) return;
      try {
        const resp = await fetch('/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await resp.json();
        if (data.success) {
          showNotification('Вы успешно вышли из системы', 'success');
          setTimeout(() => { window.location.href = '/auth/login'; }, 800);
        } else {
          showNotification('Ошибка при выходе: ' + (data.error || ''), 'error');
        }
      } catch (e) {
        console.error(e);
        showNotification('Ошибка соединения', 'error');
      }
    });
  }

  /* ===== Аватары ===== */
  const maleSrc = document.body.dataset.maleSrc || '/static/images/male.svg';
  const femaleSrc = document.body.dataset.femaleSrc || '/static/images/female.svg';

  function loadAvatarIcon(avatarEl) {
    if (!avatarEl) return;
    const sex = (avatarEl.dataset.sex || '').toLowerCase();
    let src = '';
    if (['мужской', 'м', 'male', 'm'].includes(sex)) src = maleSrc;
    else if (['женский', 'ж', 'female', 'f'].includes(sex)) src = femaleSrc;
    if (!src) return;

    // Чистим старое <img>, если есть; работаем только с одним.
    avatarEl.querySelectorAll('.avatar-img').forEach((n) => n.remove());

    const img = document.createElement('img');
    img.className = 'avatar-img';
    img.alt = 'Аватар';
    img.onload = () => avatarEl.classList.add('loaded');
    img.onerror = () => {
      img.remove();
      avatarEl.classList.remove('loaded');
    };
    img.src = src;
    avatarEl.appendChild(img);
  }

  loadAvatarIcon(document.getElementById('profileAvatar'));
  loadAvatarIcon(document.getElementById('profileModalAvatar'));
});

/* ===== WebSocket для высокочастотных сигналов клиент→сервер =====
   «Печатает» и отметки прочтения шлются десятками — гонять каждый отдельным
   HTTP-запросом расточительно. send() возвращает false, если WS недоступен —
   вызывающий код откатывается на HTTP-фолбэк. Канал сервер→клиент остаётся
   на SSE (/api/events): редкие события + авто-reconnect из коробки. */
window.HRSignals = (function () {
  // Маркер авторизации — у гостя WS сразу закроется 4401, не мучаем сервер.
  if (!document.getElementById('notifBtn') && !document.getElementById('msgrFab')) {
    return { send: () => false };
  }
  let ws = null;
  let ready = false;
  let connecting = false;
  let retryTimer = null;

  function connect() {
    if (connecting || ready || !window.WebSocket) return;
    connecting = true;
    try {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + '/api/messenger/ws');
    } catch (e) { connecting = false; return; }
    ws.onopen = () => { ready = true; connecting = false; };
    ws.onclose = () => {
      ready = false; connecting = false; ws = null;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 15000);  // редкий ретрай; HTTP-фолбэк работает
    };
    ws.onerror = () => { try { ws && ws.close(); } catch (e) {} };
  }
  connect();
  window.addEventListener('pagehide', () => { try { ws && ws.close(); } catch (e) {} });

  function send(obj) {
    if (ready && ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); return true; } catch (e) {}
    }
    connect();
    return false;
  }
  return { send };
})();

/* ===== Общий rich-toast (единый стиль для ассистента и собеседника) =====
   opts: { kind:'assistant'|'peer', avatarHtml|avatarText, from, preview,
           onClick?, href?, timeout? }
   Показываются ПО ОЧЕРЕДИ: следующий появляется после закрытия предыдущего.
   Снизу — бегущая полоска обратного отсчёта. Пока виден toast, плавающая
   кнопка чата поднимается над ним (класс body.has-toasts + --toast-lift). */
window.HRToast = (function () {
  const DEFAULT_TIMEOUT = 6000;
  const MAX_DESKTOP = 3;          // на десктопе — до трёх одновременно
  const queue = [];               // item, ожидающие показа
  const activeItems = [];         // item, видимые сейчас

  // На телефоне уведомления показываем сверху и по ОДНОМУ; их можно смахивать.
  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
  const maxVisible = () => (isMobile() ? 1 : MAX_DESKTOP);

  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s); }
  function ensureContainer() {
    let c = document.getElementById('toastContainer');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toastContainer';
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }
  // Кнопка «Скрыть все» — под всеми toast (последним элементом контейнера).
  function ensureClearBtn() {
    const c = ensureContainer();
    let b = c.querySelector('.toast-clear-all');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-clear-all';
      b.textContent = 'Скрыть все';
      b.addEventListener('click', (e) => { e.stopPropagation(); hideAll(); });
    }
    c.appendChild(b);            // всегда последний (под стеком)
    return b;
  }
  function updateChrome() {
    const c = ensureContainer();
    c.classList.toggle('toast-container--top', isMobile());   // на телефоне — сверху
    const b = ensureClearBtn();
    // «Скрыть все» — только на десктопе при стеке (на телефоне: свайп вверх, 1 toast).
    b.style.display = (!isMobile() && (activeItems.length + queue.length) >= 2) ? 'block' : 'none';
    // Плавающая кнопка чата поднимается над стеком ТОЛЬКО на десктопе (там toast снизу).
    if (activeItems.length && !isMobile()) {
      document.body.classList.add('has-toasts');
      document.body.style.setProperty('--toast-lift', c.offsetHeight + 'px');
    } else {
      document.body.classList.remove('has-toasts');
      document.body.style.setProperty('--toast-lift', '0px');
    }
  }
  // Обновление текста без пересоздания элемента (не трогает таймер).
  function applyText(el, opts) {
    const from = el.querySelector('.toast-from');
    const prev = el.querySelector('.toast-preview');
    if (from) from.textContent = opts.from || '';
    if (prev) prev.textContent = opts.preview || '';
  }

  function renderOne(item) {
    const opts = item.opts;
    const kind = opts.kind || 'info';
    const c = ensureContainer();
    const el = document.createElement('div');
    el.className = 'toast toast--rich toast--' + kind;
    const avatar = opts.avatarHtml || esc(opts.avatarText || '💬');
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    el.innerHTML =
      '<div class="toast-avatar toast-avatar--' + kind + '">' + avatar + '</div>' +
      '<div class="toast-body">' +
        '<div class="toast-from"></div>' +
        '<div class="toast-preview"></div>' +
      '</div>' +
      '<button class="toast-close" type="button" aria-label="Закрыть">&times;</button>' +
      '<div class="toast-progress"><div class="toast-progress-bar"></div></div>';
    applyText(el, opts);
    const btn = c.querySelector('.toast-clear-all');
    if (btn) c.insertBefore(el, btn); else c.appendChild(el);   // toast — над кнопкой
    item.el = el;

    const bar = el.querySelector('.toast-progress-bar');
    requestAnimationFrame(() => {
      el.classList.add('is-visible');
      updateChrome();
      requestAnimationFrame(() => {
        bar.style.transition = 'width ' + timeout + 'ms linear';
        bar.style.width = '0%';
      });
    });

    let closed = false;
    let timer = null;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      el.classList.remove('is-visible');
      setTimeout(() => {
        el.remove();
        const i = activeItems.indexOf(item);
        if (i >= 0) activeItems.splice(i, 1);
        pump();               // на освободившееся место — следующий из очереди
        updateChrome();
      }, 250);
    };
    el.querySelector('.toast-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
    if (opts.onClick) {
      el.classList.add('toast--clickable');
      el.addEventListener('click', () => { try { opts.onClick(); } catch (e) {} close(); });
    } else if (opts.href) {
      el.classList.add('toast--clickable');
      el.addEventListener('click', () => { window.location.href = opts.href; });
    }
    timer = setTimeout(close, timeout);
    item._close = close;
    if (isMobile()) attachSwipe(el, close);
  }

  function pump() {
    while (activeItems.length < maxVisible() && queue.length) {
      const item = queue.shift();
      activeItems.push(item);
      renderOne(item);
    }
    updateChrome();
  }

  // Смахивание toast на телефоне: влево/вправо — закрыть текущий; вверх — скрыть все.
  function attachSwipe(el, closeFn) {
    let sx = 0, sy = 0, dragging = false, mode = null;
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      dragging = true; mode = null; el.style.transition = 'none';
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (mode == null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        mode = (dy < 0 && Math.abs(dy) > Math.abs(dx)) ? 'up' : 'x';
      }
      if (!mode) return;
      e.preventDefault();
      if (mode === 'up') {
        el.style.transform = 'translateY(' + Math.min(0, dy) + 'px)';
        el.style.opacity = String(Math.max(0.2, 1 + dy / 160));
      } else {
        el.style.transform = 'translateX(' + dx + 'px)';
        el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 200));
      }
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      el.style.transition = '';
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (mode === 'up' && dy < -55) { hideAll(); return; }
      if (mode === 'x' && Math.abs(dx) > 80) {
        el.style.transform = 'translateX(' + (dx > 0 ? 600 : -600) + 'px)';
        el.style.opacity = '0';
        setTimeout(closeFn, 180);
        return;
      }
      el.style.transform = ''; el.style.opacity = '';   // не хватило — вернуть на место
    }, { passive: true });
  }
  function hideAll() {
    queue.length = 0;
    activeItems.slice().forEach((it) => { if (it._close) it._close(); });
    updateChrome();
  }
  function show(opts) {
    const item = { opts: opts || {}, el: null };
    // Живое обновление текста (например, название диалога подтянулось позже).
    item.update = (fields) => { Object.assign(item.opts, fields || {}); if (item.el) applyText(item.el, item.opts); };
    item.close = () => {
      if (item._close) { item._close(); return; }
      const i = queue.indexOf(item);
      if (i >= 0) { queue.splice(i, 1); updateChrome(); }
    };
    queue.push(item);
    pump();
    return item;
  }
  return { show };
})();

// ===== Глобальный тост о завершении генерации (если пользователь ушёл из чата) =====
(function pendingGenerationToaster() {
  function read() {
    try { return JSON.parse(localStorage.getItem('pendingGenerations') || '[]'); } catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem('pendingGenerations', JSON.stringify(list)); } catch (e) {}
  }
  const DEFAULT_TITLE = 'Новый диалог';
  function showToast(p) {
    const known = (p.title && p.title !== DEFAULT_TITLE) ? p.title : null;
    // Показываем СРАЗУ (не ждём авто-название). Если имени ещё нет — подтянем его
    // позже и обновим текст toast, НЕ сбрасывая таймер (handle.update).
    const handle = window.HRToast.show({
      kind: 'assistant',
      avatarHtml: '<i class="fas fa-robot"></i>',
      from: 'HR-ассистент',
      preview: 'Ответ готов' + (known ? ' · ' + known : ''),
      href: '/chat/' + encodeURIComponent(p.sessionId),
      timeout: 9000,
    });
    if (!known) pollTitle(p.sessionId, handle);
  }
  // Опрашиваем авто-название и, как только оно готово, обновляем текст toast.
  function pollTitle(sessionId, handle) {
    let tries = 0;
    const iv = setInterval(async () => {
      tries += 1;
      const title = await fetchDialogueTitle(sessionId);
      if (title && title !== DEFAULT_TITLE) {
        clearInterval(iv);
        handle.update({ preview: 'Ответ готов · ' + title });
      } else if (tries >= 12) {
        clearInterval(iv);   // ~18 с — сдаёмся, оставляем без названия
      }
    }, 1500);
  }
  async function fetchDialogueTitle(sessionId) {
    try {
      const r = await fetch('/api/dialogues?filter=all');
      if (!r.ok) return undefined;
      const d = await r.json();
      const item = (d.items || []).find((x) => String(x.session_id) === String(sessionId));
      return item ? (item.title || '') : undefined;
    } catch (e) { return undefined; }
  }
  async function check() {
    let list = read();
    if (!list.length) return;
    const curPath = window.location.pathname;
    const remaining = [];
    for (const p of list) {
      if (!p || !p.sessionId) continue;
      if (curPath === '/chat/' + p.sessionId) { remaining.push(p); continue; } // открыт сам чат
      if (Date.now() - (p.ts || 0) > 10 * 60 * 1000) continue;                 // протухло
      if (Date.now() - (p.ts || 0) < 4000) { remaining.push(p); continue; }    // даём стриму стартовать
      try {
        const r = await fetch('/api/chat/stream/active?session_id=' + encodeURIComponent(p.sessionId));
        if (!r.ok) { remaining.push(p); continue; }
        const d = await r.json();
        if (!(d.success && (!d.active || d.active.length === 0))) {
          remaining.push(p);   // ещё генерируется
          continue;
        }
        // Завершилось — показываем toast СРАЗУ (название подтянется в него позже).
        const title = await fetchDialogueTitle(p.sessionId);
        showToast({ sessionId: p.sessionId, title: (title && title !== DEFAULT_TITLE) ? title : (p.title || '') });
      } catch (e) { remaining.push(p); }
    }
    write(remaining);
    // Есть ожидающие записи (стрим стартует / ждём авто-название) — проверяем
    // снова через пару секунд, а не по 60-секундному фолбэку: иначе toast
    // о готовом ответе приходит с большой задержкой.
    if (remaining.length) scheduleCheck(2500);
  }
  // Дебаунс check(), чтобы пачка событий не плодила лишние фетчи.
  let _checkTimer = null;
  function scheduleCheck(delay) {
    clearTimeout(_checkTimer);
    _checkTimer = setTimeout(check, delay || 250);
  }

  // Глобальный SSE-канал уведомлений (#16): сервер пушит события вместо поллинга.
  let _es = null;
  function openEvents() {
    if (_es) return;  // одно соединение на страницу
    try { _es = new EventSource('/api/events'); } catch (e) { return; }
    _es.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (!data || data.type === 'ping' || data.type === 'hello') return;
      if (data.type === 'generation_done' || data.type === 'dialogue_title') {
        scheduleCheck(200);
        // Сигнал страницам /dialogues и сайдбару /chat обновиться без частого поллинга.
        window.dispatchEvent(new CustomEvent('hr:dialogues-changed', { detail: data }));
      } else if (data.type === 'user_message') {
        // Новое сообщение в чате между пользователями → мессенджер (messenger.js).
        window.dispatchEvent(new CustomEvent('hr:user-message', { detail: data.message }));
      } else if (data.type === 'user_typing') {
        window.dispatchEvent(new CustomEvent('hr:user-typing', { detail: data }));
      } else if (data.type === 'user_message_deleted') {
        window.dispatchEvent(new CustomEvent('hr:user-deleted', { detail: data }));
      } else if (data.type === 'user_message_pinned') {
        window.dispatchEvent(new CustomEvent('hr:user-pinned', { detail: data }));
      } else if (data.type === 'user_read') {
        window.dispatchEvent(new CustomEvent('hr:user-read', { detail: data }));
      } else if (data.type === 'user_message_edited') {
        window.dispatchEvent(new CustomEvent('hr:user-edited', { detail: data }));
      } else if (data.type === 'reaction_updated') {
        window.dispatchEvent(new CustomEvent('hr:reaction', { detail: data }));
      } else if (data.type === 'poll_updated') {
        window.dispatchEvent(new CustomEvent('hr:poll', { detail: data }));
      } else if (data.type === 'ai_stream') {
        window.dispatchEvent(new CustomEvent('hr:ai-stream', { detail: data }));
      } else if (data.type === 'system_notification') {
        window.dispatchEvent(new CustomEvent('hr:system-notification', { detail: data }));
      } else if (data.type === 'unread_changed') {
        // Пользователь прочитал сообщения (в этой или другой вкладке) —
        // бейдж центра уведомлений гаснет сразу.
        window.dispatchEvent(new CustomEvent('hr:unread-changed', { detail: data }));
      } else if (data.type === 'presence') {
        // Собеседник появился/ушёл — статус «Онлайн» без поллинга /presence.
        window.dispatchEvent(new CustomEvent('hr:presence', { detail: data }));
      }
    };
    _es.onerror = () => { /* EventSource переподключится сам */ };
  }
  // ВАЖНО: закрываем соединение при уходе со страницы — иначе при частой навигации
  // SSE-коннекты копятся, упираются в лимит браузера (~6) и подвешивают интерфейс.
  function closeEvents() {
    if (_es) { try { _es.close(); } catch (e) {} _es = null; }
  }
  window.addEventListener('pagehide', closeEvents);
  window.addEventListener('beforeunload', closeEvents);

  // Остаточный случай: генерация завершилась, пока ни одной вкладки не было открыто.
  if (read().length) check();
  openEvents();
  // Редкий фолбэк, если SSE недоступен (было каждые 6 с — стало 60 с).
  setInterval(() => { if (read().length) check(); }, 60000);
})();

/* ===== Мобильная клавиатура: поднимаем ТОЛЬКО поле ввода, не двигая ленту =====
   При открытии экранной клавиатуры браузер сжимает visualViewport. Мы измеряем,
   насколько поле ввода (плавающий оверлей внизу chat-box) ушло под клавиатуру, и
   ровно на столько поднимаем его вверх. Сообщения при этом остаются на месте. */
(function () {
  "use strict";
  var vv = window.visualViewport;
  if (!vv) return;
  // Только сенсорные устройства: на десктопе экранной клавиатуры нет, а chat-box
  // чуть выше вьюпорта — иначе поле ввода ошибочно «уезжало» вверх (см. регресс).
  if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return;
  var raf = null;
  function apply() {
    raf = null;
    // Высота, «съеденная» клавиатурой. Мала (<80px) — клавиатуры нет, ничего не трогаем.
    var kb = window.innerHeight - vv.height - vv.offsetTop;
    var list = document.querySelectorAll('.chat-box .input-area');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      el.style.transform = '';                     // сброс — измеряем натуральное положение
      if (kb < 80) continue;                       // нет клавиатуры — без сдвига
      var rect = el.getBoundingClientRect();
      var overlap = rect.bottom - (vv.offsetTop + vv.height);   // ушло под клавиатуру
      if (overlap > 1) el.style.transform = 'translateY(' + (-Math.round(overlap)) + 'px)';
    }
  }
  function schedule() { if (raf == null) raf = requestAnimationFrame(apply); }
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
})();

/* ===== Отступ ленты под плавающим полем ввода =====
   Поле ввода на /chat и /messenger — плавающий оверлей внизу; лента получает
   padding-bottom, чтобы последнее сообщение не пряталось под ним. Фиксированные
   108px были БОЛЬШЕ реальной высоты поля на телефоне — под полем оставалась
   пустая прокручиваемая «кромка». Считаем отступ по фактической высоте поля. */
(function () {
  "use strict";
  function sync() {
    document.querySelectorAll('.chat-box').forEach(function (box) {
      var ia = box.querySelector('.input-area');
      var msgs = box.querySelector('.messages');
      if (ia && msgs) msgs.style.paddingBottom = (ia.offsetHeight + 12) + 'px';
    });
  }
  var raf = null;
  function run() { if (raf == null) raf = requestAnimationFrame(function () { raf = null; sync(); }); }
  function start() {
    run();
    window.addEventListener('resize', run);
    window.addEventListener('orientationchange', run);
    // Высота поля меняется (раскрыли «Частые вопросы», многострочный ввод, вложения).
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(run);
      document.querySelectorAll('.chat-box .input-area').forEach(function (ia) { ro.observe(ia); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ===== Регистрация service worker (PWA) ===== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* PWA недоступен — не критично */ });
  });
}
