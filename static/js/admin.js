// admin.js — страница администрирования: пользователи, роли, просмотр переписок,
// журнал действий. Работает с /api/admin/*. Только для администраторов.
(function () {
  "use strict";

  const root = document.getElementById("adTbody") ? document : null;
  if (!root) return;
  const ME = parseInt(document.querySelector(".admin-root")?.dataset.me || "0", 10);

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  async function api(url, opts) {
    const r = await fetch(url, opts);
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((data && data.detail) || ("Ошибка " + r.status));
    return data;
  }

  // ───────────────────────── таблица пользователей ─────────────────────────
  const tbody = $("adTbody");
  let USERS = [];

  const ROLES = [
    { key: "is_admin", label: "Админ", icon: "fa-user-shield" },
    { key: "is_kb_editor", label: "Редактор БЗ", icon: "fa-book" },
    { key: "can_access_pii", label: "ПДн", icon: "fa-id-card" },
    { key: "is_active", label: "Активен", icon: "fa-circle-check" },
  ];

  function rolePill(u, role) {
    const on = !!u[role.key];
    // Себе нельзя снять админку/активность (бэкенд тоже запрещает).
    const locked = u.id === ME && (role.key === "is_admin" || role.key === "is_active");
    return (
      `<button class="ad-pill${on ? " on" : ""}${locked ? " locked" : ""}" ` +
      `data-uid="${u.id}" data-role="${role.key}" ${locked ? "disabled" : ""} ` +
      `title="${on ? "Снять" : "Выдать"}: ${esc(role.label)}">` +
      `<i class="fas ${role.icon}"></i> ${esc(role.label)}</button>`
    );
  }

  function renderUsers(list) {
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="admin-loader">Ничего не найдено</td></tr>';
      return;
    }
    tbody.innerHTML = list
      .map((u) => {
        const pills = ROLES.map((r) => rolePill(u, r)).join("");
        const inactive = u.is_active ? "" : " ad-row-inactive";
        return (
          `<tr class="ad-row${inactive}" data-uid="${u.id}">` +
          `<td><div class="ad-user"><span class="ad-ava">${esc(u.initials)}</span>` +
          `<div class="ad-user-info"><span class="ad-user-name">${esc(u.full_name)}` +
          `${u.id === ME ? ' <span class="ad-you">вы</span>' : ""}</span>` +
          `<span class="ad-user-sub">${esc(u.email)} · ${esc(u.position || "")}</span></div></div></td>` +
          `<td><div class="ad-pills">${pills}</div></td>` +
          `<td class="ac-created">${fmtDate(u.created_at)}</td>` +
          `<td class="ac-actions">` +
          `<button class="ad-icon-btn ad-view" data-uid="${u.id}" title="Просмотр переписок и действий"><i class="fa-solid fa-eye"></i></button>` +
          `<button class="ad-icon-btn ad-del" data-uid="${u.id}" title="Удалить пользователя"${u.id === ME ? " disabled" : ""}><i class="fa-solid fa-trash"></i></button>` +
          `</td></tr>`
        );
      })
      .join("");
  }

  function applyFilter() {
    const q = ($("adSearch").value || "").trim().toLowerCase();
    if (!q) return renderUsers(USERS);
    renderUsers(
      USERS.filter(
        (u) =>
          (u.full_name || "").toLowerCase().includes(q) ||
          (u.email || "").toLowerCase().includes(q)
      )
    );
  }

  async function loadUsers() {
    tbody.innerHTML = '<tr><td colspan="4" class="admin-loader">Загрузка…</td></tr>';
    try {
      const d = await api("/api/admin/users");
      USERS = d.items || [];
      applyFilter();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="admin-loader">Не удалось загрузить: ${esc(e.message)}</td></tr>`;
    }
  }

  async function toggleRole(uid, role) {
    const u = USERS.find((x) => x.id === uid);
    if (!u) return;
    const next = !u[role];
    try {
      const d = await api(`/api/admin/users/${uid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [role]: next }),
      });
      Object.assign(u, d.item);
      applyFilter();
    } catch (e) {
      alert("Не удалось изменить права: " + e.message);
    }
  }

  async function deleteUser(uid) {
    const u = USERS.find((x) => x.id === uid);
    if (!u) return;
    if (!confirm(`Удалить пользователя «${u.full_name}»?\n\nБудут безвозвратно удалены его диалоги с ботом и переписки. Действие необратимо.`))
      return;
    try {
      await api(`/api/admin/users/${uid}`, { method: "DELETE" });
      USERS = USERS.filter((x) => x.id !== uid);
      applyFilter();
    } catch (e) {
      alert("Не удалось удалить: " + e.message);
    }
  }

  tbody.addEventListener("click", (e) => {
    const pill = e.target.closest(".ad-pill");
    if (pill && !pill.disabled) return toggleRole(+pill.dataset.uid, pill.dataset.role);
    const view = e.target.closest(".ad-view");
    if (view) return openDrawer(+view.dataset.uid);
    const del = e.target.closest(".ad-del");
    if (del && !del.disabled) return deleteUser(+del.dataset.uid);
  });

  $("adSearch").addEventListener("input", applyFilter);
  $("adReload").addEventListener("click", loadUsers);

  // ───────────────────────── выезжающая панель ─────────────────────────
  const drawer = $("adDrawer");
  const backdrop = $("adDrawerBackdrop");
  const body = $("adBody");
  const tabsEl = $("adTabs");
  const backBtn = $("adDrawerBack");
  let curUser = null;
  let curTab = "dialogues";
  let goBack = null; // функция «назад» внутри вкладки (тред → список)

  function openDrawer(uid) {
    curUser = USERS.find((x) => x.id === uid);
    if (!curUser) return;
    $("adDrawerTitle").textContent = curUser.full_name;
    $("adDrawerSub").textContent = curUser.email;
    drawer.hidden = false;
    backdrop.hidden = false;
    drawer.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      drawer.classList.add("open");
      backdrop.classList.add("open");
    });
    setTab("dialogues");
  }

  function closeDrawer() {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    setTimeout(() => {
      drawer.hidden = true;
      backdrop.hidden = true;
    }, 250);
  }

  function setBack(fn) {
    goBack = fn;
    backBtn.hidden = !fn;
  }

  backBtn.addEventListener("click", () => { if (goBack) goBack(); });
  $("adDrawerClose").addEventListener("click", closeDrawer);
  backdrop.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !drawer.hidden) closeDrawer();
  });

  tabsEl.addEventListener("click", (e) => {
    const t = e.target.closest(".admin-tab");
    if (t) setTab(t.dataset.tab);
  });

  function setTab(tab) {
    curTab = tab;
    setBack(null);
    tabsEl.querySelectorAll(".admin-tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === tab)
    );
    if (tab === "dialogues") loadDialogues();
    else if (tab === "messenger") loadMessenger();
    else loadActivity();
  }

  function loading() { body.innerHTML = '<div class="ad-loading">Загрузка…</div>'; }
  function fail(e) { body.innerHTML = `<div class="ad-loading">Ошибка: ${esc(e.message)}</div>`; }

  // --- Диалоги с ботом ---
  async function loadDialogues() {
    loading();
    try {
      const d = await api(`/api/admin/users/${curUser.id}/dialogues`);
      const items = d.items || [];
      if (!items.length) { body.innerHTML = '<div class="ad-empty">Нет диалогов с ботом</div>'; return; }
      body.innerHTML =
        '<div class="ad-list">' +
        items.map((it) =>
          `<button class="ad-list-item" data-id="${it.id}">` +
          `<span class="ad-li-main"><i class="fa-solid fa-robot"></i> ${esc(it.title)}</span>` +
          `<span class="ad-li-meta">${it.messages} сообщ. · ${fmtDate(it.last_activity)}` +
          `${it.is_finished ? ' · <span class="ad-badge">решён</span>' : ""}</span></button>`
        ).join("") +
        "</div>";
      body.querySelectorAll(".ad-list-item").forEach((el) =>
        el.addEventListener("click", () => openDialogue(+el.dataset.id))
      );
    } catch (e) { fail(e); }
  }

  async function openDialogue(did) {
    loading();
    try {
      const d = await api(`/api/admin/users/${curUser.id}/dialogues/${did}/messages`);
      setBack(loadDialogues);
      const msgs = d.items || [];
      const html = msgs.length
        ? msgs.map((m) => botBubble(m)).join("")
        : '<div class="ad-empty">Пусто</div>';
      body.innerHTML = `<div class="ad-thread-title">${esc(d.title)}</div><div class="ad-thread">${html}</div>`;
    } catch (e) { fail(e); }
  }

  function botBubble(m) {
    const who = m.role === "user" ? "user" : "bot";
    const label = m.role === "user" ? curUser.short_name : "Бот";
    const src = m.sources ? `<span class="ad-msg-src">источников: ${m.sources}</span>` : "";
    return (
      `<div class="ad-msg ad-msg-${who}"><div class="ad-msg-head">${esc(label)} ` +
      `<span class="ad-msg-time">${fmtDate(m.created_at)}</span></div>` +
      `<div class="ad-msg-body">${esc(m.content) || "<i>—</i>"}</div>${src}</div>`
    );
  }

  // --- Переписки с коллегами ---
  async function loadMessenger() {
    loading();
    try {
      const d = await api(`/api/admin/users/${curUser.id}/messenger`);
      const items = d.items || [];
      if (!items.length) { body.innerHTML = '<div class="ad-empty">Нет переписок</div>'; return; }
      body.innerHTML =
        '<div class="ad-list">' +
        items.map((it) => {
          const ic = it.key === "general" ? "fa-users" : "fa-user";
          return `<button class="ad-list-item" data-key="${esc(it.key)}">` +
            `<span class="ad-li-main"><i class="fa-solid ${ic}"></i> ${esc(it.title)}</span>` +
            `<span class="ad-li-meta">${it.count} сообщ. · ${fmtDate(it.last_at)}</span></button>`;
        }).join("") +
        "</div>";
      body.querySelectorAll(".ad-list-item").forEach((el) =>
        el.addEventListener("click", () => openConversation(el.dataset.key, el.querySelector(".ad-li-main").textContent.trim()))
      );
    } catch (e) { fail(e); }
  }

  async function openConversation(key, title) {
    loading();
    try {
      const d = await api(`/api/admin/users/${curUser.id}/messenger/${encodeURIComponent(key)}`);
      setBack(loadMessenger);
      const msgs = d.items || [];
      const html = msgs.length
        ? msgs.map((m) => peerBubble(m)).join("")
        : '<div class="ad-empty">Пусто</div>';
      body.innerHTML = `<div class="ad-thread-title">${esc(title)}</div><div class="ad-thread">${html}</div>`;
    } catch (e) { fail(e); }
  }

  function peerBubble(m) {
    const side = m.is_target ? "user" : "peer";
    const atts = (m.attachments || []).length
      ? `<div class="ad-msg-atts">${m.attachments.map((a) => `<span class="ad-att"><i class="fa-solid fa-paperclip"></i> ${esc(a)}</span>`).join("")}</div>`
      : "";
    const fwd = m.forwarded ? '<span class="ad-badge">переслано</span> ' : "";
    return (
      `<div class="ad-msg ad-msg-${side}"><div class="ad-msg-head">${esc(m.sender_name)} ` +
      `<span class="ad-msg-time">${fmtDate(m.created_at)}</span></div>` +
      `<div class="ad-msg-body">${fwd}${esc(m.content) || (atts ? "" : "<i>—</i>")}</div>${atts}</div>`
    );
  }

  // --- Действия с данными ---
  const ACTION_LABEL = {
    reauth_ok: "Вход в раздел ПДн", reauth_fail: "Ошибка входа в ПДн",
    view_person: "Просмотр карточки", create_person: "Создание карточки",
    delete_person: "Удаление карточки", upload: "Загрузка документа",
    download: "Скачивание документа", delete: "Удаление документа",
    quick_analyze: "Быстрый анализ", timeout_save: "Автовыход по таймауту",
  };

  async function loadActivity() {
    loading();
    try {
      const d = await api(`/api/admin/users/${curUser.id}/activity`);
      const s = d.stats || {};
      const stats =
        '<div class="ad-stats">' +
        `<div class="ad-stat"><b>${s.dialogues || 0}</b><span>диалогов с ботом</span></div>` +
        `<div class="ad-stat"><b>${s.sent_messages || 0}</b><span>сообщений коллегам</span></div>` +
        `<div class="ad-stat"><b>${s.files || 0}</b><span>загруженных файлов</span></div>` +
        "</div>";
      const audit = d.audit || [];
      const auditHtml = audit.length
        ? '<table class="ad-audit"><thead><tr><th>Время</th><th>Действие</th><th>Объект</th></tr></thead><tbody>' +
          audit.map((r) =>
            `<tr><td>${fmtDate(r.at)}</td><td>${esc(ACTION_LABEL[r.action] || r.action)}</td>` +
            `<td>${esc(r.entity || "")}${r.entity_id ? " #" + r.entity_id : ""}</td></tr>`
          ).join("") +
          "</tbody></table>"
        : '<div class="ad-empty">Нет записей о действиях с персональными данными</div>';
      body.innerHTML =
        stats +
        '<div class="ad-section-title">Журнал действий с персональными данными</div>' +
        auditHtml;
    } catch (e) { fail(e); }
  }

  loadUsers();
})();
