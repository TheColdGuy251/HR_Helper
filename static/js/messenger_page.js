/* Полная страница чата с пользователями (/messenger). Копирует раскладку чата
   с ассистентом (сайдбар диалогов + область переписки), использует те же
   API /api/messenger и SSE-событие hr:user-message. */
(function () {
  "use strict";
  const layout = document.getElementById("mpLayout");
  if (!layout) return;

  // Открыт как отдельное окно (вынос миничата) — прячем шапку сайта, чат на весь экран.
  try { if (new URLSearchParams(location.search).has("popup")) document.body.classList.add("msgr-popup"); } catch (e) {}

  const ME = parseInt(layout.dataset.me || "0", 10);
  const $ = (id) => document.getElementById(id);
  const convsEl = $("mpConvs");
  const messagesEl = $("mpMessages");
  const searchEl = $("mpSearch");
  const inputEl = $("mpInput");
  const sendBtn = $("mpSend");
  const titleEl = $("mpTitle");
  const subtitleEl = $("mpSubtitle");
  const avatarEl = $("mpAvatar");
  const backdrop = $("mpBackdrop");
  const fwdChip = $("mpForwardChip");
  const fwdChipText = $("mpForwardChipText");
  const fileInput = $("mpFileInput");
  const pendingAttsEl = $("mpPendingAtts");
  const replyBar = $("mpReplyBar");

  const state = { key: null, peerId: null, general: false, name: "", unread: {}, pendingForward: null, pendingReply: null, pendingAtts: [], hasMore: false, loadingOlder: false, newCount: 0 };
  const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
  const U = window.MsgrUI;

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (iso) => {
    try { return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return ""; }
  };
  async function api(url, opts) {
    const r = await fetch(url, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // ─────────── сайдбар (мобильная шторка / сворачивание) ───────────
  function showSidebar() { layout.classList.remove("sidebar-collapsed"); }
  function hideSidebar() { layout.classList.add("sidebar-collapsed"); }
  $("mpSidebarToggle").addEventListener("click", () => layout.classList.toggle("sidebar-collapsed"));
  backdrop.addEventListener("click", hideSidebar);

  // «Назад» → сначала гасим контекстное меню/выделение (если открыты), и только
  // если ничего не было открыто — уходим на страницу, с которой развернули чат.
  $("mpPageBack").addEventListener("click", () => {
    if (interactions && interactions.closeOverlays && interactions.closeOverlays()) return;
    let url = "/";
    try { url = sessionStorage.getItem("msgrReturnUrl") || "/"; } catch (e) {}
    if (url === location.pathname + location.search) url = "/";
    window.location.href = url;
  });
  // На телефоне стартуем со списком чатов (шторка открыта), на десктопе сайдбар раскрыт.
  if (isMobile()) showSidebar();

  // ─────────── список диалогов ───────────
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
    div.className = "msgr-conv" + (isGeneral ? " general" : "") + (state.key === c.key ? " active" : "");
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
    div.addEventListener("click", () => openThread(c, isGeneral));
    return div;
  }

  // Ряд «HR-ассистент»: обычный клик — новый диалог в /chat; в режиме пересылки —
  // выбранные сообщения уезжают ассистенту (см. /api/messenger/forward-to-assistant).
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
    if (!term || "hr-ассистент ассистент ии бот".indexOf(term) >= 0) convsEl.appendChild(assistantRow());
    if (data.notes) convsEl.appendChild(convRow(data.notes, false));   // «Заметки» — вверху
    if (data.general) convsEl.appendChild(convRow(data.general, true));
    data.users.forEach((u) => convsEl.appendChild(convRow(u, false)));
    if (!data.users.length && !data.general && !convsEl.children.length) convsEl.innerHTML = '<div class="msgr-empty">Пользователи не найдены</div>';
  }

  // «Иванов Иван Иванович» → «Иванов И. И.» (для узкой шапки на мобильных).
  function shortNameOf(full) {
    const p = (full || "").trim().split(/\s+/);
    if (p.length < 2) return full || "";
    let s = p[0] + " " + p[1][0].toUpperCase() + ".";
    if (p[2]) s += " " + p[2][0].toUpperCase() + ".";
    return s;
  }
  function renderTitle() {
    if (state.key == null) return;
    if (isMobile() && !state.general) {
      titleEl.textContent = shortNameOf(state.name);
    } else {
      titleEl.innerHTML = U.esc(state.name) + (!state.general && state.position ? ' <span class="mp-position">· ' + U.esc(state.position) + "</span>" : "");
    }
  }
  let _titleRz = null;
  window.addEventListener("resize", () => { clearTimeout(_titleRz); _titleRz = setTimeout(renderTitle, 150); });

  // ─────────── переписка ───────────
  async function openThread(c, general) {
    // Сохраняем сообщения и позицию уходящего диалога в кеш.
    snapshotMessages(); saveScroll();
    stopTyping(); clearTypers();
    cancelReply(); state.pendingAtts = []; renderPendingAtts();
    if (typeof interactions !== "undefined" && interactions) interactions.exitSelection();
    state.key = c.key;
    state.peerId = c.peer_id;
    state.general = general;
    state.notes = !general && c.peer_id === ME;   // «Заметки» (диалог с собой)
    state.name = c.name;
    state.position = c.position;
    state.loadingOlder = false;
    // ФИО и должность — на одной строке; на мобильных — «Фамилия И. О.» без должности.
    renderTitle();
    state.subtitle = general ? "Все сотрудники" : (state.notes ? "Личные заметки и запросы к ИИ" : "");
    subtitleEl.textContent = state.subtitle;
    avatarEl.textContent = general ? "★" : (c.initials || "?");
    avatarEl.classList.toggle("general", !!general);
    try { localStorage.setItem("mpLastConv", JSON.stringify({ key: c.key, peer_id: c.peer_id, general: general, name: c.name, initials: c.initials, position: c.position })); } catch (e) {}
    // Для «Заметок» статус присутствия не нужен (это вы сами).
    if (!general && !state.notes) updatePresence(); else subtitleEl.textContent = state.subtitle;
    inputEl.disabled = false; sendBtn.disabled = false;
    messagesEl.innerHTML = '<div class="msgr-empty">Загрузка…</div>';
    fwdChip.hidden = !state.pendingForward;
    if (state.pendingForward) fwdChipText.textContent = "Переслать: " + state.pendingForward.preview;
    convsEl.querySelectorAll(".msgr-conv").forEach((el) => el.classList.remove("active"));
    if (isMobile()) hideSidebar();

    // Есть кеш → мгновенно показываем и синхронизируем новое в фоне.
    const cached = cache[c.key];
    if (cached && cached.messages.length) {
      state.hasMore = cached.hasMore;
      renderFromCache(cached);
      state.unread[c.key] = 0;
      loadConvs(searchEl.value.trim());
      syncNew();
      inputEl.focus();
      return;
    }

    messagesEl.innerHTML = '<div class="msgr-empty">Загрузка…</div>';
    try {
      const url = general ? "/api/messenger/thread?general=1" : "/api/messenger/thread?peer_id=" + c.peer_id;
      const data = await api(url);
      if (state.key !== c.key) return;   // пользователь уже переключился
      state.hasMore = !!data.has_more;
      renderMessages(data.messages, data.first_unread_id, data.unread_count);
      state.unread[c.key] = 0;
      loadConvs(searchEl.value.trim());
    } catch (e) { messagesEl.innerHTML = '<div class="msgr-empty">Ошибка загрузки</div>'; }
    inputEl.focus();
  }

  function lastMsgNode() {
    const nodes = messagesEl.querySelectorAll(".message[data-id]");
    for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i]._msg) return nodes[i];
    return null;
  }
  function lastMsg() { const n = lastMsgNode(); return n ? n._msg : null; }
  function buildInto(msgs) {   // общий рендер списка сообщений в область
    const flags = U.computeGroupFlags(msgs);
    msgs.forEach((m, i) => {
      const groupLast = (i === msgs.length - 1) || !(flags[i + 1] && flags[i + 1].grouped);
      messagesEl.appendChild(U.buildMessageNode(m, { general: state.general, grouped: flags[i].grouped, gap: flags[i].gap, hideAvatar: !groupLast, noAnim: true }));
    });
  }
  // Свежая загрузка (первый заход). Есть непрочитанные → показываем разделитель,
  // бейдж и приземляемся на первое новое; иначе — в самый низ.
  function renderMessages(msgs, firstUnreadId, unreadCount) {
    messagesEl.classList.toggle("msgr-1to1", !state.general);
    messagesEl.innerHTML = "";
    state.newCount = 0;
    if (!msgs.length) { messagesEl.innerHTML = '<div class="msgr-empty">Сообщений пока нет. Напишите первым!</div>'; updateBadge(); refreshPin(); updateScrollDown(); return; }
    buildInto(msgs);
    const dividerNode = firstUnreadId ? (placeDivider(firstUnreadId), newDivider()) : null;
    if (dividerNode) {
      state.newCount = unreadCount || 0;
      // Максимум новых под линией, но 2 сообщения до неё остаются видимыми.
      messagesEl.scrollTop = U.dividerScrollTop(dividerNode);
      _wasBottom = isNearBottom();
      if (_wasBottom) state.newCount = 0;   // всё видно — бейдж не нужен
    } else {
      scrollBottom(); _wasBottom = true;
    }
    updateBadge();
    snapshotMessages(); refreshPin(); updateScrollDown();
  }
  // Мгновенный рендер из кеша с восстановлением позиции.
  function renderFromCache(entry) {
    messagesEl.classList.toggle("msgr-1to1", !state.general);
    messagesEl.innerHTML = "";
    state.newCount = 0; updateBadge();
    if (!entry.messages.length) { messagesEl.innerHTML = '<div class="msgr-empty">Сообщений пока нет. Напишите первым!</div>'; refreshPin(); updateScrollDown(); return; }
    buildInto(entry.messages);
    restoreScroll(entry.atBottom, entry.scrollTop);
    refreshPin();
  }
  function appendMessage(m) {
    if (messagesEl.querySelector('[data-id="' + m.id + '"]')) return;
    const empty = messagesEl.querySelector(".msgr-empty");
    if (empty) messagesEl.innerHTML = "";
    const prevNode = lastMsgNode();
    const flags = U.groupFlag(prevNode ? prevNode._msg : null, m);
    if (flags.grouped && prevNode) prevNode.classList.add("msgr-hide-avatar");
    const node = U.buildMessageNode(m, { general: state.general, grouped: flags.grouped, gap: flags.gap });
    insertOrdered(node, m.id);
    // Не выдёргиваем вниз, если пользователь читает историю выше.
    if (m.mine || _wasBottom) { scrollBottom(); }
    else {
      if (!m.system) {
        if (!state.newCount) placeDivider(m.id);   // начало новой партии новых
        state.newCount++; updateBadge();
      }
      updateScrollDown();
    }
  }
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
  function firstMsgNode() {
    const nodes = messagesEl.querySelectorAll(".message[data-id]");
    for (let i = 0; i < nodes.length; i++) if (nodes[i]._msg) return nodes[i];
    return null;
  }
  // Прокрутка в самый низ. Картинки резервируют место заранее (img_w/h), поэтому
  // плавная анимация доходит ровно до низа без «дёрганого» доскролла.
  function snapBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function scrollBottom(smooth) {
    if (smooth) messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
    else { snapBottom(); requestAnimationFrame(snapBottom); }
  }

  // ─────────── кеш диалогов: не выгружаем сообщения из памяти ───────────
  const cache = {};   // key -> { messages, hasMore, scrollTop, atBottom }
  function cacheEntry() { return cache[state.key] || (cache[state.key] = { messages: [], hasMore: false, scrollTop: 0, atBottom: true }); }
  function snapshotMessages() {
    if (state.key == null) return;
    const msgs = [];
    messagesEl.querySelectorAll(".message[data-id]").forEach((n) => { if (n._msg && !String(n._msg.id).startsWith("tmp")) msgs.push(n._msg); });
    const e = cacheEntry(); e.messages = msgs; e.hasMore = state.hasMore;
  }
  let _lockTop = null, _lockTimer = null;   // удержание позиции, пока грузятся картинки
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
  const scrollDownBtn = $("mpScrollDown");
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
  // Стрелка: при наличии новых — сначала к разделителю, повторно — в самый низ.
  if (scrollDownBtn) scrollDownBtn.addEventListener("click", () => {
    const d = newDivider();
    if (state.newCount > 0 && d && d.offsetTop > messagesEl.scrollTop + 8) {
      messagesEl.scrollTo({ top: U.dividerScrollTop(d), behavior: "smooth" });
    } else {
      scrollBottom(true);
    }
  });
  let _wasBottom = true;

  // ─────────── подгрузка старых сообщений (при прокрутке к верху) ───────────
  function showTopLoader() {
    let el = messagesEl.querySelector(".msgr-load-more");
    if (!el) { el = document.createElement("div"); el.className = "msgr-load-more"; el.innerHTML = '<span class="msgr-load-spin"></span>'; messagesEl.insertBefore(el, messagesEl.firstChild); }
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
    if (firstNode && firstNode._msg) {   // стык групп на границе старой и новой партий
      const gf = U.groupFlag(msgs[msgs.length - 1], firstNode._msg);
      firstNode.classList.toggle("grouped", gf.grouped);
    }
    messagesEl.scrollTop = prevTop + (messagesEl.scrollHeight - prevH);
  }
  // Догрузка пропущенных (новых) сообщений при повторном заходе из кеша.
  async function syncNew() {
    const key = state.key;
    try {
      const url = state.general ? "/api/messenger/thread?general=1" : "/api/messenger/thread?peer_id=" + state.peerId;
      const data = await api(url);
      if (state.key !== key) return;
      const have = new Set();
      messagesEl.querySelectorAll(".message[data-id]").forEach((n) => have.add(String(n.dataset.id)));
      data.messages.filter((m) => !have.has(String(m.id))).forEach((m) => appendMessage(m));
    } catch (e) {}
  }

  messagesEl.addEventListener("scroll", () => {
    if (_lockTop != null) return;
    _wasBottom = isNearBottom();
    if (_wasBottom) clearNewBadge();   // дочитали до низа — бейдж гаснет
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
    $("mpReplyName").textContent = state.pendingReply.sender_name;
    $("mpReplyText").textContent = state.pendingReply.text;
    replyBar.hidden = false; inputEl.focus();
  }
  function cancelReply() { state.pendingReply = null; replyBar.hidden = true; }
  $("mpReplyCancel").addEventListener("click", cancelReply);

  function renderPendingAtts() {
    if (!state.pendingAtts.length) { pendingAttsEl.hidden = true; pendingAttsEl.innerHTML = ""; return; }
    pendingAttsEl.hidden = false;
    pendingAttsEl.innerHTML = U.pendingAttsHtml(state.pendingAtts);
  }
  pendingAttsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    state.pendingAtts.splice(parseInt(b.dataset.rm, 10), 1); renderPendingAtts();
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
  fileInput.addEventListener("change", async () => { await addPendingFiles(fileInput.files); fileInput.value = ""; });
  // Drag-and-drop на область чата + вставка из буфера.
  const _dz = $("mpBox");
  let _dzDepth = 0;
  const _hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0;
  _dz.addEventListener("dragenter", (e) => { if (!_hasFiles(e)) return; e.preventDefault(); _dzDepth++; _dz.classList.add("msgr-drop-active"); });
  _dz.addEventListener("dragover", (e) => { if (_hasFiles(e)) e.preventDefault(); });
  _dz.addEventListener("dragleave", () => { if (--_dzDepth <= 0) { _dzDepth = 0; _dz.classList.remove("msgr-drop-active"); } });
  _dz.addEventListener("drop", (e) => { e.preventDefault(); _dzDepth = 0; _dz.classList.remove("msgr-drop-active"); if (state.key != null && e.dataTransfer.files.length) addPendingFiles(e.dataTransfer.files); });
  inputEl.addEventListener("paste", (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addPendingFiles(files); }
  });
  const attachBtn = $("mpAttachBtn");
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
    try { const msg = await api("/api/messenger/poll", { method: "POST", body: JSON.stringify(body) }); appendMessage(msg); }
    catch (e) { alert("Не удалось создать голосование"); }
  }
  async function react(m, emoji) {
    try { const r = await api("/api/messenger/reaction", { method: "POST", body: JSON.stringify({ message_id: m.id, emoji }) }); patchMsg(m.id, { reactions: r.reactions }); } catch (e) {}
  }
  // Модалка «Вложения диалога» — клик по области от иконки до конца статуса в шапке.
  async function openAttachments() {
    if (state.key == null) return;
    const url = state.general ? "/api/messenger/attachments?general=1" : "/api/messenger/attachments?peer_id=" + state.peerId;
    try { U.attachmentsModal(await api(url), (id) => U.scrollToMessage(messagesEl, id)); } catch (e) {}
  }
  avatarEl.addEventListener("click", openAttachments);
  const headText = document.querySelector(".chat-box .chat-header-text");
  if (headText) headText.addEventListener("click", openAttachments);
  async function voteInPoll(m, optId) {
    try { const r = await api("/api/messenger/poll/vote", { method: "POST", body: JSON.stringify({ option_id: optId }) }); patchMsg(m.id, { poll: r.poll }); } catch (e) {}
  }
  function patchMsg(id, patch) {
    const n = messagesEl.querySelector('[data-id="' + id + '"]');
    if (!n || !n._msg) return;
    Object.assign(n._msg, patch);
    const fresh = U.buildMessageNode(n._msg, { general: state.general, grouped: n.classList.contains("grouped"), gap: n.classList.contains("has-gap"), hideAvatar: n.classList.contains("msgr-hide-avatar"), noAnim: true });
    n.replaceWith(fresh);
  }

  function menuItems(m, node, mapi) {
    if (m.system) return [{ label: "Удалить", icon: "fa-trash", danger: true, onClick: () => confirmDelete([m]) }];
    const base = [{ label: "Ответить", icon: "fa-reply", onClick: () => setReply(m) }];
    if (m.mine && !m.forwarded) base.push({ label: "Изменить", icon: "fa-pen", onClick: () => U.editMessage(node, m, (v) => saveEdit(m, node, v)) });
    base.push(
      { label: m.is_pinned ? "Открепить" : "Закрепить", icon: "fa-thumbtack", onClick: () => pinMsg(m) },
      { label: "Копировать", icon: "fa-copy", onClick: () => U.copyText(U.messageText(m)) },
      { label: "Переслать", icon: "fa-share", onClick: () => forwardMessages([m]) },
      { sep: true },
      { label: "Выделить", icon: "fa-check", onClick: () => mapi.startSelect() },
      { label: "Удалить", icon: "fa-trash", danger: true, onClick: () => confirmDelete([m]) },
    );
    return base;
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
    U.updatePinnedBar($("mpPinBar"), messagesEl, {
      onJump: (id) => U.scrollToMessage(messagesEl, id),
      onUnpin: (p) => pinMsg(p),
    });
  }
  function forwardMessages(msgs) {
    if (!msgs.length) return;
    const ids = msgs.map((m) => m.id);
    state.pendingForward = { userMessageIds: ids, preview: (U.messageText(msgs[0]) || "сообщение").slice(0, 40) + (ids.length > 1 ? " (+" + (ids.length - 1) + ")" : "") };
    fwdChip.hidden = false;
    fwdChipText.textContent = "Переслать выбранное — выберите чат";
    showSidebar();
    loadConvs(searchEl.value.trim());   // перерисовать ряд ассистента в режиме пересылки
  }

  const interactions = U.attachThreadInteractions({
    container: messagesEl,
    isGeneral: () => state.general,
    menuItems: menuItems,
    toolbar: {
      el: $("mpSelTools"), count: $("mpSelCount"),
      copy: $("mpSelCopy"), fwd: $("mpSelFwd"), del: $("mpSelDel"), cancel: $("mpSelCancel"),
    },
    onCopy: (msgs) => U.copyText(U.groupedCopyText(msgs)),
    onForward: (msgs) => forwardMessages(msgs),
    onDelete: (msgs) => confirmDelete(msgs, () => interactions.exitSelection()),
    onReact: (m, emoji) => react(m, emoji),
    onVote: (m, optId) => voteInPoll(m, optId),
  });

  // ─────────── отправка ───────────
  function autoGrow() { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px"; }
  inputEl.addEventListener("input", () => { autoGrow(); onTyping(); });
  inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } });
  sendBtn.addEventListener("click", onSend);

  // ─────────── режим: обычное сообщение / вопрос ИИ ───────────
  const modeBtn = $("mpModeBtn");
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
    try { const r = await api("/api/messenger/ask", { method: "POST", body: JSON.stringify(body) }); if (r && r.question) appendMessage(r.question); }
    catch (e) { inputEl.value = content; }
  }
  const aiNodes = {};
  window.addEventListener("hr:ai-stream", (e) => {
    const d = e.detail;
    if (!d || state.key !== d.peer_key) return;
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
      const fresh = U.buildMessageNode(node._msg, { general: state.general, noAnim: true });
      node.replaceWith(fresh);
      delete aiNodes[d.id]; refreshPin();
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
  const typers = {};
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
  // Онлайн-статус собеседника в подписи шапки (для 1-1).
  async function updatePresence() {
    if (state.general || state.peerId == null) return;
    try {
      const p = await api("/api/messenger/presence?peer_id=" + state.peerId);
      state.subtitle = p.online ? "Онлайн" : U.lastSeenText(p.last_seen);
    } catch (e) { state.subtitle = ""; }
    if (!Object.values(typers).some((t) => Date.now() - t.ts < 6000)) subtitleEl.textContent = state.subtitle;
  }
  // Присутствие — по SSE-пушу (см. notify.subscribe/unsubscribe), без поллинга.
  window.addEventListener("hr:presence", (e) => {
    const d = e.detail;
    if (!d || state.general || state.peerId !== d.user_id) return;
    state.subtitle = d.online ? "Онлайн" : U.lastSeenText(d.last_seen);
    if (!Object.values(typers).some((t) => Date.now() - t.ts < 6000)) subtitleEl.textContent = state.subtitle;
  });
  function renderTyping() {
    const now = Date.now();
    const active = Object.values(typers).filter((t) => now - t.ts < 6000);
    // Статус в шапке: «печатает…» / имена (в группе) / онлайн-статус.
    subtitleEl.textContent = active.length
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
    if (near) scrollBottom();
  }
  function clearTypers() { for (const k in typers) delete typers[k]; renderTyping(); }
  setInterval(renderTyping, 2500);
  window.addEventListener("hr:user-typing", (e) => {
    const d = e.detail;
    if (!d || state.key !== d.peer_key) return;
    if (d.typing) typers[d.sender_id] = { name: d.sender_name, initials: d.sender_initials, ts: Date.now() };
    else delete typers[d.sender_id];
    renderTyping();
  });

  function finalizeNode(node, msg) {
    const fresh = U.buildMessageNode(msg, { general: state.general, grouped: node.classList.contains("grouped"), gap: node.classList.contains("has-gap"), hideAvatar: node.classList.contains("msgr-hide-avatar"), noAnim: true });
    node.replaceWith(fresh);
  }
  function failNode(node) { node._msg.status = "failed"; finalizeNode(node, node._msg); }
  let tmpCounter = 0;
  async function send() {
    if (state.key == null) return;
    const content = inputEl.value.trim();
    const fwd = state.pendingForward;
    const atts = state.pendingAtts.slice();
    if (!content && !fwd && !atts.length) return;
    sendBtn.disabled = true;
    const base = {};
    if (state.general) base.general = true; else base.peer_id = state.peerId;
    const reply = state.pendingReply;
    if (reply) base.reply_to_id = reply.id;

    inputEl.value = ""; autoGrow();
    cancelForward(); cancelReply(); state.pendingAtts = []; renderPendingAtts(); stopTyping();

    try {
      if (fwd && fwd.userMessageIds) {
        for (const id of fwd.userMessageIds) {
          const msg = await api("/api/messenger/send", { method: "POST", body: JSON.stringify(Object.assign({}, base, { forward_user_message_id: id })) });
          appendMessage(msg);
        }
      } else if (fwd && fwd.chatMessageId) {
        const msg = await api("/api/messenger/send", { method: "POST", body: JSON.stringify(Object.assign({ content }, base, { forward_message_id: fwd.chatMessageId })) });
        appendMessage(msg);
      } else if (fwd && fwd.text) {
        // Пересылка своего текстового сообщения из /chat — как обычное сообщение.
        const msg = await api("/api/messenger/send", { method: "POST", body: JSON.stringify(Object.assign({}, base, { content: fwd.text })) });
        appendMessage(msg);
      } else {
        const empty = messagesEl.querySelector(".msgr-empty"); if (empty) messagesEl.innerHTML = "";
        const temp = { id: "tmp" + (++tmpCounter), mine: true, sender_id: ME, sender_name: "Вы", content, attachments: atts, created_at: new Date().toISOString(), status: "sending", is_general: state.general, reply_to: reply ? { id: reply.id, sender_name: reply.sender_name, text: reply.text } : null };
        const flags = U.groupFlag(lastMsg(), temp);
        const node = U.buildMessageNode(temp, { general: state.general, grouped: flags.grouped, gap: flags.gap });
        node.classList.add('msg-just-sent');
        messagesEl.appendChild(node); scrollBottom();
        const body = Object.assign({ content }, base);
        if (atts.length) body.attachment_ids = atts.map((a) => a.id);
        try {
          const msg = await api("/api/messenger/send", { method: "POST", body: JSON.stringify(body) });
          finalizeNode(node, msg);
        } catch (e) { failNode(node); }
      }
      loadConvs(searchEl.value.trim());
    } catch (e) {}
    sendBtn.disabled = false;
    inputEl.focus();
  }

  function cancelForward() { state.pendingForward = null; fwdChip.hidden = true; }
  $("mpForwardCancel").addEventListener("click", cancelForward);

  // ─────────── real-time ───────────
  window.addEventListener("hr:user-read", (e) => {
    const d = e.detail;
    if (!d || state.key !== d.peer_key) return;
    messagesEl.querySelectorAll(".message.mine[data-id]").forEach((n) => {
      if (n._msg && n._msg.mine && Number(n._msg.id) <= d.last_read_id && n._msg.status !== "seen") {
        n._msg.status = "seen"; finalizeNode(n, n._msg);
      }
    });
  });
  window.addEventListener("hr:user-deleted", (e) => {
    const d = e.detail;
    if (!d || state.key !== d.peer_key) return;
    const n = messagesEl.querySelector('[data-id="' + d.id + '"]'); if (n) n.remove();
    refreshPin();
  });
  window.addEventListener("hr:user-pinned", (e) => {
    const d = e.detail;
    if (!d || state.key !== d.peer_key) return;
    const n = messagesEl.querySelector('[data-id="' + d.id + '"]');
    if (n && n._msg) {
      n._msg.is_pinned = d.pinned;
      const fresh = U.buildMessageNode(n._msg, { general: state.general, grouped: n.classList.contains("grouped"), gap: n.classList.contains("has-gap"), hideAvatar: n.classList.contains("msgr-hide-avatar"), noAnim: true });
      n.replaceWith(fresh);
    }
    refreshPin();
  });
  window.addEventListener("hr:user-edited", (e) => {
    const d = e.detail;
    if (!d || state.key !== d.peer_key) return;
    const n = messagesEl.querySelector('[data-id="' + d.id + '"]');
    if (n && n._msg) {
      n._msg.content = d.content; n._msg.is_edited = true;
      const fresh = U.buildMessageNode(n._msg, { general: state.general, grouped: n.classList.contains("grouped"), gap: n.classList.contains("has-gap"), hideAvatar: n.classList.contains("msgr-hide-avatar"), noAnim: true });
      n.replaceWith(fresh); refreshPin();
    }
  });
  window.addEventListener("hr:reaction", (e) => {
    const d = e.detail;
    if (!d || state.key !== d.peer_key) return;
    patchMsg(d.id, { reactions: d.reactions });
  });
  window.addEventListener("hr:poll", (e) => {
    const d = e.detail;
    if (!d || state.key !== d.peer_key) return;
    patchMsg(d.id, { poll: d.poll });
  });
  window.addEventListener("hr:user-message", (e) => {
    const m = e.detail;
    if (!m) return;
    if (state.key === m.peer_key) {
      if (m.mine && !m.system) return;   // своё уже показано оптимистично (кроме системных)
      delete typers[m.sender_id];
      const tn = messagesEl.querySelector(".msgr-typing");
      if (tn) tn.remove();
      appendMessage(m);
      renderTyping();
      // Лёгкая отметка прочтения (раньше здесь перезапрашивался ВЕСЬ тред).
      signalRead(m);
    } else if (!m.mine && !m.system) {
      state.unread[m.peer_key] = (state.unread[m.peer_key] || 0) + 1;
      if (window.HRToast) {
        window.HRToast.show({
          kind: "peer",
          avatarText: m.is_general ? "★" : (m.sender_initials || "?"),
          from: m.is_general ? ("Общий чат · " + m.sender_name) : m.sender_name,
          preview: m.forwarded ? (m.forwarded_meta && m.forwarded_meta.ai ? "Ответ ассистента" : "↪ переслано сообщение ассистента") : U.attachLabel(m),
          onClick: () => openThread({
            key: m.peer_key,
            peer_id: m.is_general ? null : parseInt(m.peer_key, 10),
            name: m.is_general ? "Общий чат" : m.sender_name,
            initials: m.is_general ? "★" : m.sender_initials,
            position: "",
          }, !!m.is_general),
        });
      }
    }
    loadConvs(searchEl.value.trim());
  });

  // Восстановление открытого диалога: приоритет — переход из миничата
  // (msgrOpenConv), иначе — последний открытый на этой странице (mpLastConv,
  // чтобы при перезагрузке остаться в том же диалоге).
  (function restoreConv() {
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem("msgrOpenConv") || "null"); } catch (e) {}
    try { sessionStorage.removeItem("msgrOpenConv"); } catch (e) {}
    if (!stored) { try { stored = JSON.parse(localStorage.getItem("mpLastConv") || "null"); } catch (e) {} }
    if (stored && stored.key) {
      openThread({
        key: stored.key,
        peer_id: stored.peer_id,
        name: stored.name,
        initials: stored.initials || (stored.general ? "★" : (stored.name || "?").slice(0, 2).toUpperCase()),
        position: stored.position || "",
      }, !!stored.general);
    }
  })();

  // Пересылка, начатая в мини-чате на телефоне (перед переходом на /messenger):
  // восстанавливаем режим пересылки — показываем список чатов для выбора получателя.
  (function restorePendingForward() {
    let fwd = null;
    try { fwd = JSON.parse(sessionStorage.getItem("msgrPendingForward") || "null"); } catch (e) {}
    try { sessionStorage.removeItem("msgrPendingForward"); } catch (e) {}
    if (fwd && (fwd.chatMessageId || fwd.text)) {
      state.pendingForward = fwd.text
        ? { text: fwd.text, preview: fwd.preview || "сообщение" }
        : { chatMessageId: fwd.chatMessageId, preview: fwd.preview || "сообщение" };
      fwdChip.hidden = false;
      fwdChipText.textContent = "Переслать: " + (fwd.preview || "сообщение");
      showSidebar();
    }
  })();

  loadConvs();
})();
