/* Чат между пользователями. Реальное время — через SSE (событие hr:user-message,
   которое диспатчит scripts.js). Стили пузырьков переиспользуются из chat.css. */
(function () {
  "use strict";
  // На отдельной странице /messenger всё обрабатывает messenger_page.js —
  // мини-виджет не нужен (иначе задвоятся toast-уведомления).
  if (document.body.classList.contains("page-messenger")) return;
  const panel = document.getElementById("msgrPanel");
  const fab = document.getElementById("msgrFab");
  if (!panel || !fab) return;

  const ME = parseInt(panel.dataset.me || "0", 10);
  const $ = (id) => document.getElementById(id);
  const listView = $("msgrListView");
  const threadView = $("msgrThreadView");
  const convsEl = $("msgrConvs");
  const messagesEl = $("msgrMessages");
  const titleEl = $("msgrTitle");
  const headSubEl = $("msgrHeadSub");
  const backBtn = $("msgrBack");
  const searchEl = $("msgrSearch");
  const inputEl = $("msgrInput");
  const sendBtn = $("msgrSend");
  const badge = $("msgrFabBadge");
  const fwdChip = $("msgrForwardChip");
  const fwdChipText = $("msgrForwardChipText");
  const fileInput = $("msgrFileInput");
  const pendingAttsEl = $("msgrPendingAtts");
  const replyBar = $("msgrReplyBar");

  const state = {
    open: false,
    key: null,        // peer_key открытого диалога (null → список)
    peerId: null,
    general: false,
    name: "",
    unread: {},       // key -> число непрочитанных
    pendingForward: null, // { chatMessageId } | { userMessageIds:[...] }
    pendingReply: null,   // {id, sender_name, text}
    pendingAtts: [],      // [{id,name,is_image,...}]
    hasMore: false,       // есть ли более старые сообщения для подгрузки
    loadingOlder: false,
    newCount: 0,          // непросмотренные новые сообщения ниже видимой области
  };
  const U = window.MsgrUI;

  // На телефоне мини-виджет не используем: сразу открываем полноэкранную страницу
  // /messenger. Пробрасываем контекст (пересылку, нужный диалог) через sessionStorage.
  const isMobileView = () => window.matchMedia("(max-width: 900px)").matches;
  function goToMessengerPage(setup) {
    try {
      sessionStorage.setItem("msgrReturnUrl", location.pathname + location.search);
      if (setup) setup();
    } catch (e) {}
    window.location.href = "/messenger";
  }

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  const fmtTime = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  };
  // «Иванов Иван Иванович» → «Иванов И. И.»
  function shortNameOf(full) {
    const p = (full || "").trim().split(/\s+/);
    if (p.length < 2) return full || "";
    let s = p[0] + " " + p[1][0].toUpperCase() + ".";
    if (p[2]) s += " " + p[2][0].toUpperCase() + ".";
    return s;
  }

  async function api(url, opts) {
    const r = await fetch(url, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // ─────────── открытие/закрытие/состояние панели ───────────
  let lastOpenTs = 0;
  // Класс всплытия снимаем после проигрывания — чтобы drag/resize его не повторяли.
  panel.addEventListener("animationend", () => panel.classList.remove("msgr-pop"));

  // Состояние миничата (открыт/закрыт + текущий диалог) — между страницами.
  // На странице /messenger этот скрипт не работает вовсе (см. ранний return).
  function saveState() {
    try {
      localStorage.setItem("msgrWidgetState", JSON.stringify({
        open: state.open,
        conv: state.key
          ? { key: state.key, peerId: state.peerId, general: state.general, name: state.name }
          : null,
      }));
    } catch (e) {}
  }

  function openPanel(animate) {
    lastOpenTs = Date.now();
    panel.hidden = false;
    if (animate !== false) panel.classList.add("msgr-pop");   // не анимируем при восстановлении
    state.open = true;
    showList();
    loadConvs();
    saveState();
  }
  function closePanel() {
    snapshotMessages(); saveScroll();
    stopTyping();
    panel.hidden = true;
    panel.classList.remove("msgr-pop");
    state.open = false;
    state.key = null;
    saveState();
  }
  // Сброс к положению и размерам по умолчанию (двойной клик по кнопке открытия).
  function resetPanel() {
    try {
      localStorage.removeItem("msgrPanelSize");
      localStorage.removeItem("msgrPanelPos");
    } catch (e) {}
    panel.style.width = ""; panel.style.height = "";
    panel.style.left = ""; panel.style.top = ""; panel.style.right = ""; panel.style.bottom = "";
    if (!state.open) openPanel(true);
    else { showList(); loadConvs(); saveState(); }
  }

  // Кнопка-таблетка: одиночный клик открывает/закрывает МГНОВЕННО (без ожидания
  // таймера двойного клика). Двойной клик ловим по интервалу между кликами — он
  // сбрасывает панель к положению/размерам по умолчанию.
  let lastFabClick = 0;
  fab.addEventListener("click", () => {
    if (isMobileView()) { goToMessengerPage(); return; }   // на телефоне — на /messenger
    const now = Date.now();
    if (now - lastFabClick < 300) { lastFabClick = 0; resetPanel(); return; }
    lastFabClick = now;
    if (state.open) closePanel(); else openPanel();
  });
  $("msgrClose").addEventListener("click", closePanel);
  backBtn.addEventListener("click", () => {
    // «Назад» сперва гасит контекстное меню/выделение, если они открыты.
    if (interactions && interactions.closeOverlays && interactions.closeOverlays()) return;
    cancelForward(); showList(); loadConvs();
  });
  // Клик вне панели миничат НЕ закрывает — остаётся открытым (по требованию).

  // Кнопка «развернуть»: запоминаем текущую страницу (для «Назад») и открытый
  // диалог, чтобы полная страница открыла именно его.
  const expandLink = panel.querySelector(".msgr-expand");
  if (expandLink) expandLink.addEventListener("click", () => {
    try {
      sessionStorage.setItem("msgrReturnUrl", location.pathname + location.search);
      if (state.key) {
        sessionStorage.setItem("msgrOpenConv", JSON.stringify({
          key: state.key, peer_id: state.peerId, general: state.general, name: state.name,
        }));
      } else {
        sessionStorage.removeItem("msgrOpenConv");
      }
    } catch (e) {}
  });

  // ─────────── Вынос миничата в отдельное окно ───────────
  // Гибрид: Document Picture-in-Picture (Chrome/Edge — плавающее окно поверх всего),
  // иначе — обычное окно браузера (window.open). Панель — тот же DOM-узел, поэтому
  // обработчики и живые обновления (SSE) продолжают работать после переноса.
  let pipWindow = null;
  function moveToPip(win) {
    // Переносим стили приложения в документ PiP-окна.
    document.querySelectorAll('link[rel="stylesheet"], style').forEach(function (n) {
      try { win.document.head.appendChild(n.cloneNode(true)); } catch (e) {}
    });
    win.document.documentElement.setAttribute(
      "data-theme", document.documentElement.getAttribute("data-theme") || "");
    win.document.body.style.margin = "0";
    win.document.title = "Сообщения";
    panel.classList.add("msgr-in-pip");
    panel.hidden = false;
    win.document.body.appendChild(panel);
  }
  function restoreFromPip() {
    panel.classList.remove("msgr-in-pip");
    document.body.appendChild(panel);
    pipWindow = null;
  }
  async function popOut() {
    // 1) Document PiP — плавающее окно поверх всех окон/приложений.
    if (window.documentPictureInPicture && window.documentPictureInPicture.requestWindow) {
      try {
        if (!state.open) openPanel(false);
        const r = panel.getBoundingClientRect();
        pipWindow = await window.documentPictureInPicture.requestWindow({
          width: Math.round(r.width) || 400, height: Math.round(r.height) || 620,
        });
        moveToPip(pipWindow);
        pipWindow.addEventListener("pagehide", restoreFromPip, { once: true });
        return;
      } catch (e) { pipWindow = null; /* откат на окно */ }
    }
    // 2) Отдельное окно браузера. Текущий диалог кладём в localStorage (sessionStorage
    // в новое окно не переносится) — /messenger восстановит его из mpLastConv.
    try {
      if (state.key) localStorage.setItem("mpLastConv", JSON.stringify({
        key: state.key, peer_id: state.peerId, general: state.general, name: state.name,
      }));
    } catch (e) {}
    const w = window.open(
      "/messenger?popup=1", "hrMessenger",
      "width=430,height=680,menubar=no,toolbar=no,location=no,status=no,resizable=yes");
    if (w) { closePanel(); w.focus(); }
  }
  const popoutBtn = $("msgrPopout");
  if (popoutBtn) popoutBtn.addEventListener("click", popOut);

  // ─────────── изменение размера панели (за любой из 4 углов) ───────────
  {
    const MINW = 320, MINH = 380;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // Восстановить сохранённый размер.
    try {
      const sz = JSON.parse(localStorage.getItem("msgrPanelSize") || "null");
      if (sz && sz.w) { panel.style.width = sz.w + "px"; panel.style.height = sz.h + "px"; }
    } catch (e) {}
    let rz = null;
    panel.querySelectorAll(".msgr-resize").forEach((handle) => {
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const r = panel.getBoundingClientRect();
        // Тянем угол — противоположный угол остаётся на месте (фиксируем его через
        // left/top/right/bottom исходного прямоугольника).
        rz = {
          dir: handle.dataset.dir || "se",
          sx: e.clientX, sy: e.clientY,
          left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height,
        };
        document.body.style.userSelect = "none";
        panel.classList.add("msgr-resizing");
      });
    });
    window.addEventListener("mousemove", (e) => {
      if (!rz) return;
      const dx = e.clientX - rz.sx, dy = e.clientY - rz.sy;
      const dir = rz.dir;
      let left = rz.left, top = rz.top, w = rz.w, h = rz.h;
      if (dir.includes("e")) w = clamp(rz.w + dx, MINW, window.innerWidth - rz.left);
      if (dir.includes("w")) { w = clamp(rz.w - dx, MINW, rz.right); left = rz.right - w; }
      if (dir.includes("s")) h = clamp(rz.h + dy, MINH, window.innerHeight - rz.top);
      if (dir.includes("n")) { h = clamp(rz.h - dy, MINH, rz.bottom); top = rz.bottom - h; }
      panel.style.width = w + "px";
      panel.style.height = h + "px";
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      if (!rz) return;
      rz = null;
      lastOpenTs = Date.now();   // не закрывать панель кликом, завершившим ресайз
      document.body.style.userSelect = "";
      panel.classList.remove("msgr-resizing");
      try {
        const r = panel.getBoundingClientRect();
        localStorage.setItem("msgrPanelSize", JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
        localStorage.setItem("msgrPanelPos", JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
      } catch (e) {}
    });
  }

  // ─────────── перетаскивание панели за шапку ───────────
  // Клик по области названия открывает «Вложения диалога»; если этим же
  // движением панель тащили — клик надо подавить (см. openAttachments-хендлер).
  let suppressHeadClick = false;
  const headEl = panel.querySelector(".msgr-head");
  if (headEl) {
    const isMobile = () => window.matchMedia("(max-width: 520px)").matches;

    // Переставить панель в left/top-позиционирование с зажимом в границы окна.
    function applyPos(left, top) {
      const w = panel.offsetWidth, h = panel.offsetHeight;
      left = Math.max(0, Math.min(window.innerWidth - w, left));
      top = Math.max(0, Math.min(window.innerHeight - h, top));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    }

    // Восстановить сохранённую позицию (на узком экране панель на весь экран — пропускаем).
    try {
      const pos = JSON.parse(localStorage.getItem("msgrPanelPos") || "null");
      if (pos && typeof pos.left === "number" && !isMobile()) applyPos(pos.left, pos.top);
    } catch (e) {}

    let drag = null;
    headEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || isMobile()) return;
      if (e.target.closest("button, a")) return;   // кнопки шапки — не для таскания
      const r = panel.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, active: false };
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.active) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;   // порог: отличить клик от таскания
        drag.active = true;
        document.body.style.userSelect = "none";            // не выделять текст при перетаскивании
        panel.classList.add("msgr-dragging");
      }
      applyPos(drag.left + dx, drag.top + dy);
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return;
      const wasActive = drag.active;
      drag = null;
      if (!wasActive) return;
      document.body.style.userSelect = "";
      panel.classList.remove("msgr-dragging");
      lastOpenTs = Date.now();          // не закрывать панель кликом, завершившим таскание
      suppressHeadClick = true;         // подавить клик «открыть вложения» после drag
      setTimeout(() => { suppressHeadClick = false; }, 0);
      try {
        const r = panel.getBoundingClientRect();
        localStorage.setItem("msgrPanelPos", JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
      } catch (e) {}
    });
  }

  // ─────────── список диалогов ───────────
  function showList() {
    snapshotMessages(); saveScroll();
    state.key = null;
    listView.hidden = false;
    threadView.hidden = true;
    backBtn.hidden = true;
    titleEl.textContent = state.pendingForward ? "Кому переслать?" : "Сообщения";
    // В списке нет собеседника — гасим статус («Онлайн»/«не в сети»), чтобы он
    // не завис от прошлого диалога. peerId сбрасываем, чтобы SSE-пуш присутствия
    // по старому собеседнику не всплывал в шапке списка.
    state.peerId = null;
    state.subtitle = "";
    headSubEl.textContent = "";
    saveState();
  }

  let searchTimer = null;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadConvs(searchEl.value.trim()), 220);
  });

  async function loadConvs(q) {
    try {
      const data = await api("/api/messenger/conversations?q=" + encodeURIComponent(q || ""));
      renderConvs(data);
    } catch (e) { convsEl.innerHTML = '<div class="msgr-empty">Не удалось загрузить</div>'; }
  }

  function convRow(c, isGeneral) {
    const div = document.createElement("div");
    div.className = "msgr-conv" + (isGeneral ? " general" : "");
    div.innerHTML =
      '<div class="msgr-conv-avatar">' + esc(c.initials) + "</div>" +
      '<div class="msgr-conv-body">' +
        '<div class="msgr-conv-name">' + esc(c.name) + "</div>" +
        '<div class="msgr-conv-last">' + esc(c.last_text || (isGeneral ? "Чат со всеми сотрудниками" : c.position)) + "</div>" +
      "</div>" +
      '<div class="msgr-conv-meta">' +
        (c.unread > 0 ? '<span class="msgr-conv-unread">' + c.unread + "</span>" : "") +
      "</div>";
    state.unread[c.key] = c.unread || 0;
    div.addEventListener("click", () =>
      openThread(c.key, c.peer_id, isGeneral, c.name)
    );
    return div;
  }

  // Ряд «HR-ассистент»: обычный клик — новый диалог в /chat; в режиме пересылки
  // (выбраны сообщения пользователей) — они уезжают в новый диалог с ассистентом.
  function assistantRow() {
    const fwdMode = !!(state.pendingForward && state.pendingForward.userMessageIds);
    const div = document.createElement("div");
    div.className = "msgr-conv msgr-conv-assistant";
    div.innerHTML =
      '<div class="msgr-conv-avatar assistant"><i class="fa-solid fa-robot"></i></div>' +
      '<div class="msgr-conv-body">' +
        '<div class="msgr-conv-name">HR-ассистент</div>' +
        '<div class="msgr-conv-last">' + (fwdMode ? "Переслать ассистенту и обсудить" : "Задать вопрос в новом диалоге") + "</div>" +
      "</div>";
    div.addEventListener("click", openAssistant);
    return div;
  }
  async function openAssistant() {
    const fwd = state.pendingForward;
    try {
      if (fwd && fwd.userMessageIds && fwd.userMessageIds.length) {
        const r = await api("/api/messenger/forward-to-assistant", {
          method: "POST",
          body: JSON.stringify({ message_ids: fwd.userMessageIds }),
        });
        cancelForward();
        if (r && r.session_id) window.location.href = "/chat/" + r.session_id;
        return;
      }
      const r = await api("/api/dialogues", { method: "POST", body: JSON.stringify({}) });
      if (r && r.session_id) window.location.href = "/chat/" + r.session_id;
    } catch (e) { alert("Не удалось открыть диалог с ассистентом"); }
  }

  function renderConvs(data) {
    convsEl.innerHTML = "";
    const term = (searchEl.value || "").trim().toLowerCase();
    // Пересылку ответа ассистента (chatMessageId) самому ассистенту не предлагаем.
    const fwdAi = !!(state.pendingForward && state.pendingForward.chatMessageId);
    if (!fwdAi && (!term || "hr-ассистент ассистент ии бот".indexOf(term) >= 0)) {
      convsEl.appendChild(assistantRow());
    }
    if (data.notes) convsEl.appendChild(convRow(data.notes, false));   // «Заметки» — вверху
    if (data.general) convsEl.appendChild(convRow(data.general, true));
    if (!data.users.length && !data.general && !convsEl.children.length) {
      convsEl.innerHTML = '<div class="msgr-empty">Пользователи не найдены</div>';
    }
    data.users.forEach((u) => convsEl.appendChild(convRow(u, false)));
    refreshBadge();
  }

  // ─────────── переписка ───────────
  async function openThread(key, peerId, general, name) {
    snapshotMessages(); saveScroll();   // сохранить уходящий диалог в кеш
    stopTyping(); clearTypers();
    cancelReply(); state.pendingAtts = []; renderPendingAtts();
    if (typeof interactions !== "undefined" && interactions) interactions.exitSelection();
    state.key = key;
    state.peerId = peerId;
    state.general = general;
    state.notes = !general && peerId === ME;   // «Заметки» (диалог с собой)
    state.name = name;
    state.loadingOlder = false;
    listView.hidden = true;
    threadView.hidden = false;
    backBtn.hidden = false;
    // На узком экране мини-панель разворачивается на весь экран — сокращаем ФИО.
    titleEl.textContent = (!general && window.matchMedia("(max-width: 520px)").matches) ? shortNameOf(name) : name;
    state.subtitle = general ? "Общий чат" : (state.notes ? "Личные заметки" : "");
    headSubEl.textContent = state.subtitle;
    fwdChip.hidden = !state.pendingForward;
    if (state.pendingForward) fwdChipText.textContent = "Переслать: " + state.pendingForward.preview;
    if (!general && !state.notes) updatePresence();
    saveState();   // запомнить открытый диалог для восстановления между страницами

    const cached = cache[key];
    if (cached && cached.messages.length) {
      state.hasMore = cached.hasMore;
      renderFromCache(cached);
      state.unread[key] = 0; refreshBadge();
      syncNew();
      inputEl.focus();
      return;
    }

    messagesEl.innerHTML = '<div class="msgr-empty">Загрузка…</div>';
    try {
      const url = general ? "/api/messenger/thread?general=1" : "/api/messenger/thread?peer_id=" + peerId;
      const data = await api(url);
      if (state.key !== key) return;
      state.hasMore = !!data.has_more;
      renderMessages(data.messages, data.first_unread_id, data.unread_count);
      state.unread[key] = 0;
      refreshBadge();
    } catch (e) { messagesEl.innerHTML = '<div class="msgr-empty">Ошибка загрузки</div>'; }
    inputEl.focus();
  }
  async function updatePresence() {
    if (state.general || state.peerId == null) return;
    try {
      const p = await api("/api/messenger/presence?peer_id=" + state.peerId);
      state.subtitle = p.online ? "Онлайн" : U.lastSeenText(p.last_seen);
    } catch (e) { state.subtitle = ""; }
    if (!Object.values(typers).some((t) => Date.now() - t.ts < 6000)) headSubEl.textContent = state.subtitle;
  }
  // Присутствие — по SSE-пушу (см. notify.subscribe/unsubscribe), без поллинга.
  window.addEventListener("hr:presence", (e) => {
    const d = e.detail;
    if (!d || !state.open || state.general || state.peerId !== d.user_id) return;
    state.subtitle = d.online ? "Онлайн" : U.lastSeenText(d.last_seen);
    if (!Object.values(typers).some((t) => Date.now() - t.ts < 6000)) headSubEl.textContent = state.subtitle;
  });

  function lastMsgNode() {
    const nodes = messagesEl.querySelectorAll(".message[data-id]");
    for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i]._msg) return nodes[i];
    return null;
  }
  function lastMsg() { const n = lastMsgNode(); return n ? n._msg : null; }
  // Вставить узел по порядку id (числовые id → по возрастанию; временные — в конец).
  function insertOrdered(node, id) {
    const numId = Number(id);
    if (!isNaN(numId)) {
      const nodes = messagesEl.querySelectorAll(".message[data-id]");
      for (const n of nodes) {
        if (n === node) continue;
        const nid = Number(n.dataset.id);
        if (!isNaN(nid) && nid > numId) { messagesEl.insertBefore(node, n); return; }
      }
    }
    const tn = messagesEl.querySelector(".msgr-typing");
    if (tn) messagesEl.insertBefore(node, tn); else messagesEl.appendChild(node);
  }
  // Добавить сообщение с учётом группировки относительно предыдущего.
  function appendMsg(m) {
    const prevNode = lastMsgNode();
    const flags = U.groupFlag(prevNode ? prevNode._msg : null, m);
    // Новое сообщение — последнее в группе (аватар у него); у предыдущего прячем.
    if (flags.grouped && prevNode) prevNode.classList.add("msgr-hide-avatar");
    const node = U.buildMessageNode(m, { general: state.general, grouped: flags.grouped, gap: flags.gap });
    insertOrdered(node, m.id);
    return node;
  }
  function firstMsgNode() {
    const nodes = messagesEl.querySelectorAll(".message[data-id]");
    for (let i = 0; i < nodes.length; i++) if (nodes[i]._msg) return nodes[i];
    return null;
  }
  function buildInto(msgs) {
    const flags = U.computeGroupFlags(msgs);
    msgs.forEach((m, i) => {
      const groupLast = (i === msgs.length - 1) || !(flags[i + 1] && flags[i + 1].grouped);
      messagesEl.appendChild(U.buildMessageNode(m, { general: state.general, grouped: flags[i].grouped, gap: flags[i].gap, hideAvatar: !groupLast, noAnim: true }));
    });
  }
  function renderMessages(msgs, firstUnreadId, unreadCount) {
    messagesEl.classList.toggle("msgr-1to1", !state.general);   // в 1-1 без аватаров
    messagesEl.innerHTML = "";
    state.newCount = 0;
    if (!msgs.length) { messagesEl.innerHTML = '<div class="msgr-empty">Сообщений пока нет</div>'; updateBadge(); refreshPin(); updateScrollDown(); return; }
    buildInto(msgs);
    const dividerNode = firstUnreadId ? (placeDivider(firstUnreadId), newDivider()) : null;
    if (dividerNode) {
      state.newCount = unreadCount || 0;
      // Максимум новых под линией, но 2 сообщения до неё остаются видимыми.
      messagesEl.scrollTop = U.dividerScrollTop(dividerNode);
      _wasBottom = isNearBottom();
      if (_wasBottom) state.newCount = 0;
    } else {
      scrollBottom(); _wasBottom = true;
    }
    updateBadge();
    snapshotMessages(); refreshPin(); updateScrollDown();
  }
  function renderFromCache(entry) {
    messagesEl.classList.toggle("msgr-1to1", !state.general);
    messagesEl.innerHTML = "";
    state.newCount = 0; updateBadge();
    if (!entry.messages.length) { messagesEl.innerHTML = '<div class="msgr-empty">Сообщений пока нет</div>'; refreshPin(); updateScrollDown(); return; }
    buildInto(entry.messages);
    restoreScroll(entry.atBottom, entry.scrollTop);
    refreshPin();
  }
  // Обработка входящего сообщения: держим низ / показываем разделитель+бейдж.
  function markIncoming(m) {
    if (m.mine || _wasBottom) { scrollBottom(); return; }
    if (!m.system) {
      if (!state.newCount) placeDivider(m.id);
      state.newCount++; updateBadge();
    }
    updateScrollDown();
  }
  // Прокрутка в самый низ (без «дёрганого» доскролла — картинки резервируют место).
  function snapBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function scrollBottom(smooth) {
    if (smooth) messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
    else { snapBottom(); requestAnimationFrame(snapBottom); }
  }

  // ─────────── кеш диалогов: не выгружаем сообщения из памяти ───────────
  const cache = {};
  function cacheEntry() { return cache[state.key] || (cache[state.key] = { messages: [], hasMore: false, scrollTop: 0, atBottom: true }); }
  function snapshotMessages() {
    if (state.key == null) return;
    const msgs = [];
    messagesEl.querySelectorAll(".message[data-id]").forEach((n) => { if (n._msg && !String(n._msg.id).startsWith("tmp")) msgs.push(n._msg); });
    const e = cacheEntry(); e.messages = msgs; e.hasMore = state.hasMore;
  }
  let _lockTop = null, _lockTimer = null;
  function saveScroll() {
    if (state.key == null || _lockTop != null) return;
    const e = cacheEntry(); e.scrollTop = messagesEl.scrollTop; e.atBottom = isNearBottom();
  }
  function restoreScroll(atBottom, top) {
    clearTimeout(_lockTimer); _lockTop = null;
    if (!atBottom) {
      messagesEl.scrollTop = top;
      _wasBottom = false; _lockTop = top;
      _lockTimer = setTimeout(() => { _lockTop = null; updateScrollDown(); }, 900);
    } else { scrollBottom(); _wasBottom = true; }
    updateScrollDown();
  }
  // ─────────── «Новые сообщения»: разделитель + бейдж на стрелке ───────────
  const scrollDownBtn = $("msgrScrollDown");
  const scrollDownBadge = scrollDownBtn ? scrollDownBtn.querySelector(".msgr-sd-badge") : null;
  function newDivider() { return messagesEl.querySelector(".msgr-new-divider"); }
  function removeDivider() { const d = newDivider(); if (d) d.remove(); }
  function placeDivider(beforeId) {
    removeDivider();
    const node = messagesEl.querySelector('.message[data-id="' + beforeId + '"]');
    if (!node) return;
    const d = document.createElement("div");
    d.className = "msgr-new-divider";
    d.innerHTML = "<span>Новые сообщения</span>";
    messagesEl.insertBefore(d, node);
  }
  function updateBadge() {
    if (!scrollDownBadge) return;
    if (state.newCount > 0) { scrollDownBadge.textContent = state.newCount > 99 ? "99+" : state.newCount; scrollDownBadge.hidden = false; }
    else scrollDownBadge.hidden = true;
  }
  function clearNewBadge() { if (state.newCount) { state.newCount = 0; updateBadge(); } }
  function updateScrollDown() {
    if (!scrollDownBtn) return;
    scrollDownBtn.hidden = state.key == null || (isNearBottom() && !state.newCount);
  }
  if (scrollDownBtn) scrollDownBtn.addEventListener("click", () => {
    const d = newDivider();
    if (state.newCount > 0 && d && d.offsetTop > messagesEl.scrollTop + 8) {
      messagesEl.scrollTo({ top: U.dividerScrollTop(d), behavior: "smooth" });
    } else {
      scrollBottom(true);
    }
  });
  let _wasBottom = true;

  // ─────────── подгрузка старых сообщений ───────────
  function showTopLoader() {
    if (!messagesEl.querySelector(".msgr-load-more")) {
      const el = document.createElement("div"); el.className = "msgr-load-more";
      el.innerHTML = '<span class="msgr-load-spin"></span>';
      messagesEl.insertBefore(el, messagesEl.firstChild);
    }
  }
  function hideTopLoader() { const el = messagesEl.querySelector(".msgr-load-more"); if (el) el.remove(); }
  async function loadOlder() {
    if (state.loadingOlder || !state.hasMore) return;
    const first = firstMsgNode(); if (!first) return;
    state.loadingOlder = true; showTopLoader();
    const key = state.key, beforeId = Number(first.dataset.id);
    try {
      const base = state.general ? "/api/messenger/thread?general=1" : "/api/messenger/thread?peer_id=" + state.peerId;
      const data = await api(base + "&before_id=" + beforeId);
      if (state.key !== key) { state.loadingOlder = false; return; }
      hideTopLoader();
      prependOlder(data.messages);
      state.hasMore = !!data.has_more && data.messages.length > 0;
    } catch (e) { hideTopLoader(); }
    state.loadingOlder = false;
  }
  function prependOlder(msgs) {
    if (!msgs.length) return;
    const prevH = messagesEl.scrollHeight, prevTop = messagesEl.scrollTop;
    const firstNode = firstMsgNode();
    const flags = U.computeGroupFlags(msgs);
    const frag = document.createDocumentFragment();
    msgs.forEach((m, i) => {
      const groupLast = (i === msgs.length - 1) || !(flags[i + 1] && flags[i + 1].grouped);
      frag.appendChild(U.buildMessageNode(m, { general: state.general, grouped: flags[i].grouped, gap: flags[i].gap, hideAvatar: !groupLast, noAnim: true }));
    });
    messagesEl.insertBefore(frag, firstNode);
    if (firstNode && firstNode._msg) {
      const gf = U.groupFlag(msgs[msgs.length - 1], firstNode._msg);
      firstNode.classList.toggle("grouped", gf.grouped);
    }
    messagesEl.scrollTop = prevTop + (messagesEl.scrollHeight - prevH);
  }
  async function syncNew() {
    const key = state.key;
    try {
      const url = state.general ? "/api/messenger/thread?general=1" : "/api/messenger/thread?peer_id=" + state.peerId;
      const data = await api(url);
      if (state.key !== key) return;
      const have = new Set();
      messagesEl.querySelectorAll(".message[data-id]").forEach((n) => have.add(String(n.dataset.id)));
      data.messages.filter((m) => !have.has(String(m.id))).forEach((m) => {
        appendMsg(m); markIncoming(m);
      });
    } catch (e) {}
  }

  messagesEl.addEventListener("scroll", () => {
    if (_lockTop != null) return;
    _wasBottom = isNearBottom();
    if (_wasBottom) clearNewBadge();
    saveScroll(); updateScrollDown();
    if (messagesEl.scrollTop < 160) loadOlder();
  });
  messagesEl.addEventListener("load", (e) => {
    if (!(e.target && e.target.tagName === "IMG")) return;
    if (_lockTop != null) messagesEl.scrollTop = _lockTop;
    else if (_wasBottom) scrollBottom();
  }, true);

  // ─────────── ответ / вложения / контекстное меню / выделение ───────────
  function setReply(m) {
    state.pendingReply = { id: m.id, sender_name: m.mine ? "Вы" : m.sender_name, text: U.messageText(m).slice(0, 80) };
    $("msgrReplyName").textContent = state.pendingReply.sender_name;
    $("msgrReplyText").textContent = state.pendingReply.text;
    replyBar.hidden = false;
    inputEl.focus();
  }
  function cancelReply() { state.pendingReply = null; replyBar.hidden = true; }
  $("msgrReplyCancel").addEventListener("click", cancelReply);

  function renderPendingAtts() {
    if (!state.pendingAtts.length) { pendingAttsEl.hidden = true; pendingAttsEl.innerHTML = ""; return; }
    pendingAttsEl.hidden = false;
    pendingAttsEl.innerHTML = U.pendingAttsHtml(state.pendingAtts);
  }
  pendingAttsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    state.pendingAtts.splice(parseInt(b.dataset.rm, 10), 1);
    renderPendingAtts();
  });
  async function addPendingFiles(fileList) {
    for (const file of fileList) {
      if (state.pendingAtts.length >= 10) { alert("Не более 10 вложений в одном сообщении"); break; }
      const fd = new FormData(); fd.append("file", file);
      try {
        const r = await fetch("/api/messenger/upload", { method: "POST", body: fd });
        if (r.ok) { state.pendingAtts.push(await r.json()); renderPendingAtts(); }
        else { const d = await r.json().catch(() => ({})); alert(d.detail || "Не удалось загрузить файл"); }
      } catch (e) {}
    }
  }
  // Drag-and-drop файлов/картинок на область переписки.
  const _dz = threadView;
  let _dzDepth = 0;
  const _hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0;
  _dz.addEventListener("dragenter", (e) => { if (!_hasFiles(e)) return; e.preventDefault(); _dzDepth++; _dz.classList.add("msgr-drop-active"); });
  _dz.addEventListener("dragover", (e) => { if (_hasFiles(e)) e.preventDefault(); });
  _dz.addEventListener("dragleave", () => { if (--_dzDepth <= 0) { _dzDepth = 0; _dz.classList.remove("msgr-drop-active"); } });
  _dz.addEventListener("drop", (e) => { e.preventDefault(); _dzDepth = 0; _dz.classList.remove("msgr-drop-active"); if (state.key != null && e.dataTransfer.files.length) addPendingFiles(e.dataTransfer.files); });
  // Вставка (Ctrl+V) картинок/файлов из буфера.
  inputEl.addEventListener("paste", (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addPendingFiles(files); }
  });
  fileInput.addEventListener("change", async () => {
    await addPendingFiles(fileInput.files);
    fileInput.value = "";
  });
  // Меню скрепки: загрузить файл / начать голосование (голосование — только в
  // диалоге с числом участников > 2, т.е. в общем чате).
  const attachBtn = $("msgrAttachBtn");
  if (attachBtn) attachBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const items = [{ label: "Загрузить файл", icon: "fa-paperclip", onClick: () => fileInput.click() }];
    if (state.general) items.push({ label: "Начать голосование", icon: "fa-square-poll-vertical", onClick: () => U.pollModal(createPoll) });
    const r = attachBtn.getBoundingClientRect();
    U.showContextMenu(r.left, r.top - 8, items);
  });
  async function createPoll(payload) {
    const body = Object.assign({}, payload);
    if (state.general) body.general = true; else body.peer_id = state.peerId;
    try { const msg = await api("/api/messenger/poll", { method: "POST", body: JSON.stringify(body) }); appendOwn(msg); }
    catch (e) { alert("Не удалось создать голосование"); }
  }
  async function react(m, emoji) {
    try { const r = await api("/api/messenger/reaction", { method: "POST", body: JSON.stringify({ message_id: m.id, emoji }) }); patchMsg(m.id, { reactions: r.reactions }); } catch (e) {}
  }
  // Модалка «Вложения диалога» — по клику на область названия/статуса в шапке.
  async function openAttachments() {
    if (state.key == null) return;
    const url = state.general ? "/api/messenger/attachments?general=1" : "/api/messenger/attachments?peer_id=" + state.peerId;
    try { U.attachmentsModal(await api(url), (id) => U.scrollToMessage(messagesEl, id)); } catch (e) {}
  }
  const headTitles = panel.querySelector(".msgr-head-titles");
  if (headTitles) headTitles.addEventListener("click", () => { if (!suppressHeadClick) openAttachments(); });
  async function voteInPoll(m, optId) {
    try { const r = await api("/api/messenger/poll/vote", { method: "POST", body: JSON.stringify({ option_id: optId }) }); patchMsg(m.id, { poll: r.poll }); } catch (e) {}
  }
  // Обновить одно сообщение (реакции/голосование) без перезагрузки ленты.
  function patchMsg(id, patch) {
    const n = messagesEl.querySelector('[data-id="' + id + '"]');
    if (!n || !n._msg) return;
    Object.assign(n._msg, patch);
    appendMsgReplace(n, n._msg);
  }

  function menuItems(m, node, mapi) {
    if (m.system) return [{ label: "Удалить", icon: "fa-trash", danger: true, onClick: () => confirmDelete([m]) }];
    const items = [{ label: "Ответить", icon: "fa-reply", onClick: () => setReply(m) }];
    if (m.mine && !m.forwarded) items.push({ label: "Изменить", icon: "fa-pen", onClick: () => U.editMessage(node, m, (v) => saveEdit(m, node, v)) });
    items.push(
      { label: m.is_pinned ? "Открепить" : "Закрепить", icon: "fa-thumbtack", onClick: () => pinMsg(m) },
      { label: "Копировать", icon: "fa-copy", onClick: () => U.copyText(U.messageText(m)) },
      { label: "Переслать", icon: "fa-share", onClick: () => forwardMessages([m]) },
      { sep: true },
      { label: "Выделить", icon: "fa-check", onClick: () => mapi.startSelect() },
      { label: "Удалить", icon: "fa-trash", danger: true, onClick: () => confirmDelete([m]) },
    );
    return items;
  }
  async function pinMsg(m) {
    try { await api("/api/messenger/pin", { method: "POST", body: JSON.stringify({ message_id: m.id, pinned: !m.is_pinned }) }); } catch (e) {}
  }
  async function saveEdit(m, node, content) {
    try {
      await api("/api/messenger/edit", { method: "POST", body: JSON.stringify({ message_id: m.id, content }) });
      node._msg.content = content; node._msg.is_edited = true; finalizeNode(node, node._msg); refreshPin();
    } catch (e) {}
  }
  // Удаление с подтверждением: «для всех» доступно, только если ВСЕ выбранные — свои.
  function confirmDelete(msgs, onDone) {
    if (!msgs.length) return;
    const allMine = msgs.every((m) => m.mine && !m.system);
    U.confirmDelete(msgs.length, allMine, (forAll) => { deleteMsgs(msgs, forAll).then(() => onDone && onDone()); });
  }
  async function deleteMsgs(msgs, forAll) {
    for (const m of msgs) {
      try {
        await fetch("/api/messenger/messages/" + m.id + (forAll && m.mine ? "?for_all=1" : ""), { method: "DELETE" });
        const n = messagesEl.querySelector('[data-id="' + m.id + '"]'); if (n) n.remove();
      } catch (e) {}
    }
    refreshPin();
  }
  function refreshPin() {
    U.updatePinnedBar($("msgrPinBar"), messagesEl, {
      onJump: (id) => U.scrollToMessage(messagesEl, id),
      onUnpin: (p) => pinMsg(p),
    });
  }
  function forwardMessages(msgs) {
    if (!msgs.length) return;
    const ids = msgs.map((m) => m.id);
    const first = msgs[0];
    state.pendingForward = { userMessageIds: ids, preview: (U.messageText(first) || "сообщение").slice(0, 40) + (ids.length > 1 ? " (+" + (ids.length - 1) + ")" : "") };
    lastOpenTs = Date.now();
    showList();
    loadConvs();
  }

  const interactions = U.attachThreadInteractions({
    container: messagesEl,
    isGeneral: () => state.general,
    menuItems: menuItems,
    toolbar: {
      el: $("msgrSelTools"), count: $("msgrSelCount"),
      copy: $("msgrSelCopy"), fwd: $("msgrSelFwd"), del: $("msgrSelDel"), cancel: $("msgrSelCancel"),
    },
    onCopy: (msgs) => U.copyText(U.groupedCopyText(msgs)),
    onForward: (msgs) => forwardMessages(msgs),
    onDelete: (msgs) => confirmDelete(msgs, () => interactions.exitSelection()),
    onReact: (m, emoji) => react(m, emoji),
    onVote: (m, optId) => voteInPoll(m, optId),
  });

  // ─────────── отправка ───────────
  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  }
  inputEl.addEventListener("input", () => { autoGrow(); onTyping(); });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  sendBtn.addEventListener("click", onSend);

  // ─────────── переключатель режима: обычное сообщение / вопрос ИИ ───────────
  const modeBtn = $("msgrModeBtn");
  function setMode(mode) {
    modeBtn.dataset.mode = mode;
    modeBtn.querySelector("i").className = mode === "ai" ? "fa-solid fa-robot" : "fa-solid fa-comment";
    inputEl.placeholder = mode === "ai" ? "Спросить ИИ…" : "Сообщение";
  }
  if (modeBtn) modeBtn.addEventListener("click", () => setMode(modeBtn.dataset.mode === "ai" ? "normal" : "ai"));
  function onSend() { if (modeBtn && modeBtn.dataset.mode === "ai") askAI(); else send(); }
  async function askAI() {
    const content = inputEl.value.trim();
    if (!content || state.key == null) return;
    inputEl.value = ""; autoGrow(); stopTyping();
    const body = { content };
    if (state.general) body.general = true; else body.peer_id = state.peerId;
    try { const r = await api("/api/messenger/ask", { method: "POST", body: JSON.stringify(body) }); if (r && r.question) appendOwn(r.question); }
    catch (e) { inputEl.value = content; }
  }

  // Стрим ответа ИИ (виден обоим участникам; выравнивание — по спросившему).
  const aiNodes = {};
  window.addEventListener("hr:ai-stream", (e) => {
    const d = e.detail;
    if (!d || !state.open || state.key !== d.peer_key) return;
    let node = aiNodes[d.id];
    if (!node) {
      const m = { id: d.id, mine: d.asker_id === ME, sender_id: d.asker_id, sender_name: "", sender_initials: "", forwarded: true, forwarded_meta: { content: "", sources: [], ai: true }, created_at: new Date().toISOString(), is_general: state.general };
      const ex = messagesEl.querySelector('[data-id="' + d.id + '"]'); if (ex) ex.remove();
      const empty = messagesEl.querySelector(".msgr-empty"); if (empty) messagesEl.innerHTML = "";
      node = U.buildAiStreamNode(m, d.status);
      node._acc = ""; node._srcs = [];
      insertOrdered(node, d.id);   // ниже вопроса (у вопроса id меньше)
      aiNodes[d.id] = node; scrollBottom();
    }
    if (d.phase === "status") U.setAiStatus(node, d.status);
    else if (d.phase === "sources") node._srcs = d.sources || [];
    else if (d.phase === "chunk") { node._acc += d.chunk; U.setAiText(node, node._acc); if (isNearBottom()) scrollBottom(); }
    else if (d.phase === "done") {
      node._msg.forwarded_meta = { content: d.content, sources: d.sources || node._srcs, ai: true };
      appendMsgReplace(node, node._msg);
      delete aiNodes[d.id];
      refreshPin();
    }
  });

  // «Показать все источники/документы» в пересланном ответе ассистента.
  messagesEl.addEventListener("click", (e) => {
    const more = e.target.closest(".md-sources-more");
    if (!more) return;
    const box = more.closest(".md-docs, .md-sources");
    if (box) box.classList.remove("is-collapsible");
    more.remove();
  });

  // ─────────── индикатор «печатает» ───────────
  const typers = {};            // sender_id -> {name, initials, ts}
  let lastTypingSent = 0, stopTypingTimer = null;
  function pingTyping(isTyping) {
    if (state.key == null || state.notes) return;   // в «Заметках» некому печатать
    const body = { typing: isTyping };
    if (state.general) body.general = true; else body.peer_id = state.peerId;
    // Основной канал — WebSocket (частый сигнал); HTTP — фолбэк.
    if (window.HRSignals && window.HRSignals.send(Object.assign({ type: "typing" }, body))) return;
    fetch("/api/messenger/typing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  }
  function signalRead(m) {
    const body = m.is_general ? { general: true } : { peer_id: parseInt(m.peer_key, 10) };
    if (window.HRSignals && window.HRSignals.send(Object.assign({ type: "read" }, body))) return;
    fetch("/api/messenger/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  }
  function onTyping() {
    if (state.key == null) return;
    clearTimeout(stopTypingTimer);
    if (inputEl.value.trim()) {
      const now = Date.now();
      if (now - lastTypingSent > 2500) { lastTypingSent = now; pingTyping(true); }
      stopTypingTimer = setTimeout(() => { lastTypingSent = 0; pingTyping(false); }, 3500);
    } else { lastTypingSent = 0; pingTyping(false); }
  }
  function stopTyping() { clearTimeout(stopTypingTimer); if (lastTypingSent) { lastTypingSent = 0; pingTyping(false); } }
  function isNearBottom() { return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80; }
  function renderTyping() {
    const now = Date.now();
    const active = Object.values(typers).filter((t) => now - t.ts < 6000);
    // Статус в шапке миничата: печатает… / имена (в группе) / онлайн-статус.
    if (headSubEl) headSubEl.textContent = active.length
      ? (state.general ? window.MsgrUI.typingLabel(active.map((t) => t.name)) : "печатает…")
      : (state.subtitle || "");
    const existing = messagesEl.querySelector(".msgr-typing");
    if (!active.length) { if (existing) existing.remove(); return; }
    const label = state.general ? window.MsgrUI.typingLabel(active.map((t) => t.name)) : "";
    const ava = window.MsgrUI.esc(active[0].initials || "?");
    // Пузырёк НЕ пересоздаём на каждый ping/тик — иначе анимация появления
    // проигрывается заново; пересборка только при смене автора/подписи.
    if (existing) {
      if (existing._label === label && existing._ava === ava) return;
      const fresh = window.MsgrUI.buildTypingNode({ avatar: ava, label });
      fresh._label = label; fresh._ava = ava;
      existing.replaceWith(fresh);
      return;
    }
    const near = isNearBottom();
    const node = window.MsgrUI.buildTypingNode({ avatar: ava, label });
    node._label = label; node._ava = ava;
    messagesEl.appendChild(node);
    if (near) scrollBottom();   // не дёргать вниз, если пользователь читает выше
  }
  function clearTypers() { for (const k in typers) delete typers[k]; renderTyping(); }
  setInterval(renderTyping, 2500);   // авто-скрытие протухших
  window.addEventListener("hr:user-typing", (e) => {
    const d = e.detail;
    if (!d || !state.open || state.key !== d.peer_key) return;
    if (d.typing) typers[d.sender_id] = { name: d.sender_name, initials: d.sender_initials, ts: Date.now() };
    else delete typers[d.sender_id];
    renderTyping();
  });

  function appendOwn(msg) {
    if (!messagesEl.querySelector('[data-id="' + msg.id + '"]')) {
      const empty = messagesEl.querySelector(".msgr-empty");
      if (empty) messagesEl.innerHTML = "";
      appendMsg(msg);
      scrollBottom();
    }
  }
  // Оптимистичная замена/провал временного пузыря.
  function finalizeNode(node, msg) {
    const fresh = U.buildMessageNode(msg, { general: state.general, grouped: node.classList.contains("grouped"), gap: node.classList.contains("has-gap"), hideAvatar: node.classList.contains("msgr-hide-avatar"), noAnim: true });
    node.replaceWith(fresh);
  }
  function failNode(node) {
    node._msg.status = "failed";
    finalizeNode(node, node._msg);
  }
  let tmpCounter = 0;
  async function send() {
    const content = inputEl.value.trim();
    const fwd = state.pendingForward;
    const atts = state.pendingAtts.slice();
    if (!content && !fwd && !atts.length) return;
    sendBtn.disabled = true;
    const base = {};
    if (state.general) base.general = true; else base.peer_id = state.peerId;
    const reply = state.pendingReply;
    if (reply) base.reply_to_id = reply.id;

    // очистка полей сразу (контент уже захвачен)
    inputEl.value = ""; autoGrow();
    cancelForward(); cancelReply(); state.pendingAtts = []; renderPendingAtts(); stopTyping();

    try {
      if (fwd && fwd.userMessageIds) {
        for (const id of fwd.userMessageIds) {
          const msg = await api("/api/messenger/send", { method: "POST", body: JSON.stringify(Object.assign({}, base, { forward_user_message_id: id })) });
          appendOwn(msg);
        }
      } else if (fwd && fwd.chatMessageId) {
        const msg = await api("/api/messenger/send", { method: "POST", body: JSON.stringify(Object.assign({ content }, base, { forward_message_id: fwd.chatMessageId })) });
        appendOwn(msg);
      } else if (fwd && fwd.text) {
        // Пересылка своего текстового сообщения из /chat — как обычное сообщение.
        const msg = await api("/api/messenger/send", { method: "POST", body: JSON.stringify(Object.assign({}, base, { content: fwd.text })) });
        appendOwn(msg);
      } else {
        // обычное сообщение — оптимистичный пузырь со статусом «отправляется»
        const empty = messagesEl.querySelector(".msgr-empty"); if (empty) messagesEl.innerHTML = "";
        const temp = { id: "tmp" + (++tmpCounter), mine: true, sender_id: ME, sender_name: "Вы", content, attachments: atts, created_at: new Date().toISOString(), status: "sending", is_general: state.general, reply_to: reply ? { id: reply.id, sender_name: reply.sender_name, text: reply.text } : null };
        const node = appendMsg(temp); if (node) node.classList.add('msg-just-sent'); scrollBottom();
        const body = Object.assign({ content }, base);
        if (atts.length) body.attachment_ids = atts.map((a) => a.id);
        try {
          const msg = await api("/api/messenger/send", { method: "POST", body: JSON.stringify(body) });
          finalizeNode(node, msg);
        } catch (e) { failNode(node); }
      }
    } catch (e) { /* пересылка не удалась — тихо */ }
    sendBtn.disabled = false;
    inputEl.focus();
  }

  // ─────────── пересылка сообщений ассистента ───────────
  function cancelForward() {
    state.pendingForward = null;
    fwdChip.hidden = true;
  }
  $("msgrForwardCancel").addEventListener("click", cancelForward);

  // Публичный вход из chat.js: переслать конкретное сообщение ассистента.
  window.MessengerForward = function (chatMessageId, preview) {
    const pv = (preview || "сообщение").slice(0, 40);
    if (isMobileView()) {
      goToMessengerPage(() => sessionStorage.setItem(
        "msgrPendingForward", JSON.stringify({ chatMessageId: chatMessageId, preview: pv })));
      return;
    }
    state.pendingForward = { chatMessageId: chatMessageId, preview: pv };
    lastOpenTs = Date.now();
    if (!state.open) openPanel(); else { showList(); loadConvs(); }
  };

  // Пересылка СВОЕГО текстового сообщения из /chat (обычным сообщением коллеге).
  window.MessengerForwardText = function (text, preview) {
    const pv = (preview || text || "сообщение").slice(0, 40);
    if (isMobileView()) {
      goToMessengerPage(() => sessionStorage.setItem(
        "msgrPendingForward", JSON.stringify({ text: text, preview: pv })));
      return;
    }
    state.pendingForward = { text: text, preview: pv };
    lastOpenTs = Date.now();
    if (!state.open) openPanel(); else { showList(); loadConvs(); }
  };

  // Открыть панель сразу на нужном диалоге (из toast-уведомления о новом сообщении).
  function openPanelToThread(peerKey, peerId, general, name) {
    lastOpenTs = Date.now();
    panel.hidden = false;
    state.open = true;
    openThread(peerKey, peerId, general, name);
  }
  window.MessengerOpen = function (m) {
    if (!m) return;
    const general = !!m.is_general;
    const name = general ? "Общий чат" : (m.sender_name || "Диалог");
    const peerId = general ? null : parseInt(m.peer_key, 10);
    if (isMobileView()) {
      goToMessengerPage(() => sessionStorage.setItem("msgrOpenConv",
        JSON.stringify({ key: m.peer_key, peer_id: peerId, general: general, name: name })));
      return;
    }
    openPanelToThread(m.peer_key, peerId, general, name);
  };

  // ─────────── real-time (SSE) ───────────
  window.addEventListener("hr:user-message", (e) => {
    const m = e.detail;
    if (!m) return;
    const inThread = state.open && state.key === m.peer_key;
    if (inThread) {
      // Свои сообщения уже показаны оптимистично в этой вкладке — не дублируем
      // (системные строки добавляются сервером, их показываем всегда).
      if (m.mine && !m.system) return;
      delete typers[m.sender_id];
      if (!messagesEl.querySelector('[data-id="' + m.id + '"]')) {
        const empty = messagesEl.querySelector(".msgr-empty");
        if (empty) messagesEl.innerHTML = "";
        appendMsg(m);
        renderTyping();
        markIncoming(m);
      }
      // Лёгкая отметка прочтения (раньше здесь перезапрашивался ВЕСЬ тред).
      signalRead(m);
    } else if (!m.mine && !m.system) {
      state.unread[m.peer_key] = (state.unread[m.peer_key] || 0) + 1;
      refreshBadge();
      if (state.open && !state.key) loadConvs(searchEl.value.trim());
      // Всплывающее уведомление — клик открывает миничат на этом диалоге.
      if (window.HRToast) {
        window.HRToast.show({
          kind: "peer",
          avatarText: m.is_general ? "★" : (m.sender_initials || "?"),
          from: m.is_general ? ("Общий чат · " + m.sender_name) : m.sender_name,
          preview: m.forwarded ? (m.forwarded_meta && m.forwarded_meta.ai ? "Ответ ассистента" : "↪ переслано сообщение ассистента") : U.attachLabel(m),
          onClick: () => window.MessengerOpen(m),
        });
      }
    }
  });

  // Прочтение собеседником → двойная галочка у своих сообщений.
  window.addEventListener("hr:user-read", (e) => {
    const d = e.detail;
    if (!d || !state.open || state.key !== d.peer_key) return;
    messagesEl.querySelectorAll(".message.mine[data-id]").forEach((n) => {
      if (n._msg && n._msg.mine && Number(n._msg.id) <= d.last_read_id && n._msg.status !== "seen") {
        n._msg.status = "seen";
        finalizeNode(n, n._msg);
      }
    });
  });
  // Удаление / закрепление / правка сообщений в реальном времени.
  window.addEventListener("hr:user-deleted", (e) => {
    const d = e.detail;
    if (!d || !state.open || state.key !== d.peer_key) return;
    const n = messagesEl.querySelector('[data-id="' + d.id + '"]');
    if (n) n.remove();
    refreshPin();
  });
  window.addEventListener("hr:user-pinned", (e) => {
    const d = e.detail;
    if (!d || !state.open || state.key !== d.peer_key) return;
    const n = messagesEl.querySelector('[data-id="' + d.id + '"]');
    if (n && n._msg) { n._msg.is_pinned = d.pinned; appendMsgReplace(n, n._msg); }
    refreshPin();
  });
  window.addEventListener("hr:user-edited", (e) => {
    const d = e.detail;
    if (!d || !state.open || state.key !== d.peer_key) return;
    const n = messagesEl.querySelector('[data-id="' + d.id + '"]');
    if (n && n._msg) { n._msg.content = d.content; n._msg.is_edited = true; appendMsgReplace(n, n._msg); refreshPin(); }
  });
  window.addEventListener("hr:reaction", (e) => {
    const d = e.detail;
    if (!d || !state.open || state.key !== d.peer_key) return;
    patchMsg(d.id, { reactions: d.reactions });
  });
  window.addEventListener("hr:poll", (e) => {
    const d = e.detail;
    if (!d || !state.open || state.key !== d.peer_key) return;
    patchMsg(d.id, { poll: d.poll });
  });
  function appendMsgReplace(node, m) {
    const fresh = U.buildMessageNode(m, { general: state.general, grouped: node.classList.contains("grouped"), gap: node.classList.contains("has-gap"), hideAvatar: node.classList.contains("msgr-hide-avatar"), noAnim: true });
    node.replaceWith(fresh);
    return fresh;
  }

  function refreshBadge() {
    const total = Object.values(state.unread).reduce((a, b) => a + (b || 0), 0);
    if (total > 0) { badge.hidden = false; badge.textContent = total > 99 ? "99+" : total; }
    else badge.hidden = true;
  }

  // Стартовая загрузка счётчика непрочитанных (без открытия панели).
  (async function initBadge() {
    try {
      const data = await api("/api/messenger/conversations");
      state.unread = {};
      if (data.general) state.unread[data.general.key] = data.general.unread || 0;
      data.users.forEach((u) => (state.unread[u.key] = u.unread || 0));
      refreshBadge();
    } catch (e) {}
  })();

  // Восстановление состояния миничата с прошлой страницы: открыт/закрыт и на каком
  // диалоге. На /messenger скрипт не работает (ранний return) — исключение учтено.
  (function restoreState() {
    let st = null;
    try { st = JSON.parse(localStorage.getItem("msgrWidgetState") || "null"); } catch (e) {}
    if (!st || !st.open) return;
    openPanel(false);   // без анимации всплытия — как будто панель не закрывалась
    const c = st.conv;
    if (c && c.key) openThread(c.key, c.peerId, c.general, c.name);
  })();
})();
