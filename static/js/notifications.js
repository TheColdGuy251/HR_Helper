/* Центр уведомлений (колокольчик в шапке): модалка с тремя вкладками.
   - Мессенджер: диалоги с непрочитанными от людей → клик открывает миничат;
   - ИИ-ассистент: диалоги с непрочитанными ответами ИИ → клик открывает /chat;
   - Система: обновления веб-страниц БЗ (постоянные) → клик открывает diff-просмотр.
   Бейдж на кнопке окрашивается по источнику: зелёный — мессенджер, синий — ИИ,
   красный — система; несколько источников → градиент из активных цветов. */
(function () {
  "use strict";
  const btn = document.getElementById("notifBtn");
  const badge = document.getElementById("notifBadge");
  if (!btn || !badge) return;

  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s));
  const COLORS = { messenger: "#16a34a", ai: "#1e40af", system: "#dc2626" };
  const TABS = [
    { key: "messenger", label: "Мессенджер", icon: "fa-comments" },
    { key: "ai", label: "ИИ-ассистент", icon: "fa-robot" },
    { key: "system", label: "Система", icon: "fa-gear" },
  ];

  let data = null;            // последний ответ /api/notifications
  let overlay = null;
  let activeTab = "messenger";

  function fmtTime(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
      const now = new Date();
      const p = (n) => String(n).padStart(2, "0");
      const hm = p(d.getHours()) + ":" + p(d.getMinutes());
      const same = d.toDateString() === now.toDateString();
      return same ? hm : p(d.getDate()) + "." + p(d.getMonth() + 1) + " " + hm;
    } catch (e) { return ""; }
  }

  function applyBadge(counts) {
    const total = (counts.messenger || 0) + (counts.ai || 0) + (counts.system || 0);
    if (!total) { badge.hidden = true; return; }
    badge.hidden = false;
    badge.textContent = total > 99 ? "99+" : String(total);
    const active = TABS.map((t) => t.key).filter((k) => counts[k] > 0).map((k) => COLORS[k]);
    badge.style.background = active.length === 1
      ? active[0]
      : "linear-gradient(135deg, " + active.join(", ") + ")";
  }

  let reloadTimer = null;
  function scheduleReload(delay) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reload, delay || 300);
  }

  async function reload() {
    try {
      const r = await fetch("/api/notifications");
      if (!r.ok) return;
      data = await r.json();
      applyBadge(data.counts || {});
      if (overlay && !overlay.hidden) renderModal();
    } catch (e) { /* сеть моргнула — следующий цикл */ }
  }

  /* ─────────── модалка ─────────── */
  function ensureModal() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "ntf-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="ntf-modal" role="dialog" aria-modal="true" aria-label="Уведомления">' +
        '<div class="ntf-head"><span class="ntf-title"><i class="fa-regular fa-bell"></i> Уведомления</span>' +
        '<button class="ntf-close" type="button" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>' +
        '<div class="ntf-tabs"></div>' +
        '<div class="ntf-body"></div>' +
      "</div>";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".ntf-close").addEventListener("click", close);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay && !overlay.hidden) close();
    });
  }

  function open() {
    ensureModal();
    overlay.hidden = false;
    renderModal();
    reload();
  }
  function close() { if (overlay) overlay.hidden = true; }

  function renderModal() {
    if (!overlay || !data) return;
    const counts = data.counts || {};
    const tabsEl = overlay.querySelector(".ntf-tabs");
    tabsEl.innerHTML = TABS.map((t) => {
      const n = counts[t.key] || 0;
      return '<button class="ntf-tab' + (activeTab === t.key ? " active" : "") + '" data-tab="' + t.key + '">' +
        '<i class="fa-solid ' + t.icon + '"></i> ' + t.label +
        (n ? '<span class="ntf-tab-count" style="background:' + COLORS[t.key] + '">' + n + "</span>" : "") +
        "</button>";
    }).join("");
    tabsEl.querySelectorAll(".ntf-tab").forEach((b) => {
      b.addEventListener("click", () => { activeTab = b.dataset.tab; renderModal(); });
    });
    renderList();
  }

  function renderList() {
    const body = overlay.querySelector(".ntf-body");
    const items = (data && data[activeTab]) || [];

    if (activeTab === "system") {
      const unread = items.some((i) => !i.is_read);
      let html = unread
        ? '<div class="ntf-toolbar"><button class="ntf-readall" type="button">' +
          '<i class="fa-solid fa-check-double"></i> Отметить все просмотренными</button></div>'
        : "";
      html += items.length ? items.map(systemItemHtml).join("") :
        '<div class="ntf-empty">Системных уведомлений нет</div>';
      body.innerHTML = html;
      const ra = body.querySelector(".ntf-readall");
      if (ra) ra.addEventListener("click", async () => {
        try { await fetch("/api/notifications/system/read", { method: "POST" }); } catch (e) {}
        reload();
      });
      body.querySelectorAll(".ntf-item[data-nid]").forEach((el) => {
        el.addEventListener("click", async () => {
          const nid = el.dataset.nid;
          const url = el.dataset.url;
          try { await fetch("/api/notifications/" + nid + "/read", { method: "POST" }); } catch (e) {}
          reload();
          if (url) window.open(url, "_blank", "noopener");
        });
      });
      return;
    }

    if (!items.length) {
      body.innerHTML = '<div class="ntf-empty">' +
        (activeTab === "messenger" ? "Непрочитанных сообщений нет" : "Непрочитанных ответов ассистента нет") +
        "</div>";
      return;
    }

    if (activeTab === "messenger") {
      body.innerHTML = items.map((i) =>
        '<div class="ntf-item" data-peer="' + esc(i.peer_key) + '">' +
          '<div class="ntf-ava" style="background:' + COLORS.messenger + '">' + esc(i.initials || "?") + "</div>" +
          '<div class="ntf-info"><div class="ntf-name">' + esc(i.name) + "</div>" +
          '<div class="ntf-preview">' + esc(i.preview || "") + "</div></div>" +
          '<div class="ntf-meta"><span class="ntf-time">' + fmtTime(i.at) + "</span>" +
          '<span class="ntf-count" style="background:' + COLORS.messenger + '">' + i.unread + "</span></div>" +
        "</div>").join("");
      body.querySelectorAll(".ntf-item[data-peer]").forEach((el, idx) => {
        el.addEventListener("click", () => {
          const it = items[idx];
          close();
          if (typeof window.MessengerOpen === "function") {
            window.MessengerOpen({
              peer_key: it.peer_key,
              is_general: !!it.is_general,
              sender_name: it.is_general ? "Общий чат" : it.name,
              sender_initials: it.initials,
            });
          } else {
            window.location.href = "/messenger";   // страница /messenger: миничата нет
          }
        });
      });
      return;
    }

    // ai
    body.innerHTML = items.map((i) =>
      '<div class="ntf-item" data-sid="' + esc(i.session_id) + '">' +
        '<div class="ntf-ava" style="background:' + COLORS.ai + '"><i class="fa-solid fa-robot"></i></div>' +
        '<div class="ntf-info"><div class="ntf-name">' + esc(i.title) + "</div>" +
        '<div class="ntf-preview">' + esc(i.preview || "") + "</div></div>" +
        '<div class="ntf-meta"><span class="ntf-time">' + fmtTime(i.at) + "</span>" +
        '<span class="ntf-count" style="background:' + COLORS.ai + '">' + i.unread + "</span></div>" +
      "</div>").join("");
    body.querySelectorAll(".ntf-item[data-sid]").forEach((el) => {
      el.addEventListener("click", () => {
        window.location.href = "/chat/" + el.dataset.sid;
      });
    });
  }

  function systemItemHtml(i) {
    // Иконка и подсказка по типу: web_update — изменение веб-страницы (diff),
    // doc_expired — автоархив по сроку действия, doc_stale — проверка актуальности.
    const icons = { web_update: "fa-globe", doc_expired: "fa-box-archive", doc_stale: "fa-clock" };
    const icon = icons[i.kind] || "fa-gear";
    const hint = i.diff_url
      ? (i.kind === "web_update"
        ? '<div class="ntf-hint"><i class="fa-solid fa-magnifying-glass"></i> Открыть изменения</div>'
        : '<div class="ntf-hint"><i class="fa-solid fa-file-lines"></i> Открыть документ</div>')
      : "";
    return '<div class="ntf-item ntf-system' + (i.is_read ? " is-read" : "") + '" data-nid="' + i.id + '"' +
      (i.diff_url ? ' data-url="' + esc(i.diff_url) + '"' : "") + ">" +
      '<div class="ntf-ava" style="background:' + COLORS.system + '"><i class="fa-solid ' + icon + '"></i></div>' +
      '<div class="ntf-info"><div class="ntf-name">' + esc(i.title) + "</div>" +
      '<div class="ntf-preview">' + esc(i.body || "") + "</div>" +
      hint +
      "</div>" +
      '<div class="ntf-meta"><span class="ntf-time">' + fmtTime(i.at) + "</span>" +
      (!i.is_read ? '<span class="ntf-dot" style="background:' + COLORS.system + '"></span>' : "") +
      "</div></div>";
  }

  /* ─────────── события ─────────── */
  btn.addEventListener("click", () => {
    if (overlay && !overlay.hidden) close(); else open();
  });
  ["hr:user-message", "hr:user-read", "hr:unread-changed", "hr:dialogues-changed", "hr:system-notification"]
    .forEach((ev) => window.addEventListener(ev, () => scheduleReload(400)));

  reload();
  // Фолбэк на случай недоступного SSE: редко и только при видимой вкладке;
  // при возврате на вкладку — одна синхронизация.
  setInterval(() => { if (!document.hidden) reload(); }, 180000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleReload(200); });
})();

/* ===== Системные уведомления: Web Push (закрытое приложение) + Notification API ===== */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) return;

  function urlB64ToUint8Array(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function subscribe() {
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const r = await fetch("/api/push/vapid-public-key");
        const d = await r.json();
        if (!d || !d.key) return;   // VAPID/pywebpush не настроены — тихо
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(d.key),
        });
      }
      await fetch("/api/push/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: Object.assign(sub.toJSON(), { ua: navigator.userAgent }) }),
      });
    } catch (e) { /* push недоступен (нет HTTPS/разрешения/пакета) */ }
  }

  async function enable() {
    if (Notification.permission === "granted") { subscribe(); return; }
    if (Notification.permission === "default") {
      try { if ((await Notification.requestPermission()) === "granted") subscribe(); } catch (e) {}
    }
  }
  window.HRPush = { enable: enable };

  if (Notification.permission === "granted") subscribe();

  // Клик по колокольчику — уместный момент спросить разрешение (нужен жест пользователя).
  const bell = document.getElementById("notifBtn");
  if (bell) bell.addEventListener("click", function () {
    if (Notification.permission === "default") enable();
  });

  // Уведомление сразу (вкладка открыта, но не на виду) — не дожидаясь серверного push.
  // Тот же tag, что у серверного → без дублей.
  window.addEventListener("hr:user-message", function (e) {
    const m = e && e.detail;
    if (!m || m.mine || m.system) return;
    if (Notification.permission !== "granted" || !document.hidden) return;
    navigator.serviceWorker.ready.then(function (reg) {
      const title = m.is_general ? "Общий чат" : (m.sender_name || "Новое сообщение");
      let body = m.forwarded ? "Ответ ассистента" : (m.content || "📎 вложение");
      if (m.is_general && m.sender_name) body = m.sender_name + ": " + body;
      reg.showNotification(title, {
        body: String(body).slice(0, 120),
        icon: "/static/images/pwa-192.png",
        badge: "/static/images/pwa-192.png",
        tag: "msgr-" + m.peer_key, renotify: true, data: { url: "/messenger" },
      });
    }).catch(function () {});
  });
})();
