/* Лента новостей HR: превью-карточки (обложка + текст), клик открывает отдельную
   страницу статьи (/news/{id}). Публикация/правка — только у редакторов БЗ.
   Редактор: текст + вставка картинок и документов ПО МЕСТУ КУРСОРА. Тело
   санитизируется на сервере — показываем как есть. */
(function () {
  "use strict";
  const root = document.querySelector(".news-root");
  if (!root) return;
  const canEdit = root.dataset.canEdit === "1";
  const feed = document.getElementById("newsFeed");
  const $ = (id) => document.getElementById(id);

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtDate = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
    } catch (e) { return ""; }
  };
  const fmtSize = (n) => {
    n = n || 0;
    if (n < 1024) return n + " Б";
    if (n < 1048576) return (n / 1024).toFixed(0) + " КБ";
    return (n / 1048576).toFixed(1) + " МБ";
  };
  const fileIcon = (name) => {
    const e = (name || "").split(".").pop().toLowerCase();
    if (e === "pdf") return "fa-file-pdf";
    if (["doc", "docx", "rtf", "odt"].includes(e)) return "fa-file-word";
    if (["xls", "xlsx", "xlsm", "csv", "ods"].includes(e)) return "fa-file-excel";
    if (["ppt", "pptx", "odp"].includes(e)) return "fa-file-powerpoint";
    if (["zip", "rar", "7z"].includes(e)) return "fa-file-zipper";
    if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(e)) return "fa-file-image";
    return "fa-file-lines";
  };
  // Карточка-документ в стиле вложений /chat и /messenger: клик по основной
  // области открывает предпросмотр (pdf/docx/xlsx/txt/…), кнопка справа — скачать.
  const docCardHtml = (m) =>
    '<span class="news-doc" contenteditable="false">' +
    '<a class="news-doc-main" href="/news/media/' + m.id + '/view" target="_blank" rel="noopener" title="Открыть предпросмотр">' +
    '<span class="news-doc-ic"><i class="fas ' + fileIcon(m.name) + '"></i></span>' +
    '<span class="news-doc-info">' +
    '<span class="news-doc-title">' + esc(m.name) + '</span>' +
    '<span class="news-doc-size">' + fmtSize(m.size) + '</span></span></a>' +
    '<a class="news-doc-dl" href="' + esc(m.url) + '?download=1" title="Скачать" aria-label="Скачать">' +
    '<i class="fas fa-download"></i></a></span>';

  async function api(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) {
      let m = "HTTP " + r.status;
      try { const j = await r.json(); m = j.detail || m; } catch (e) {}
      throw new Error(m);
    }
    return r.json();
  }

  let posts = [];

  // ─────────────────────────── лента (превью) ───────────────────────────
  function cardHtml(p) {
    const cover = p.preview_image
      ? `<div class="news-card-cover"><img src="${esc(p.preview_image)}" alt="" loading="lazy"></div>`
      : "";
    const excerpt = p.excerpt
      ? `<p class="news-card-excerpt">${esc(p.excerpt)}</p>`
      : "";
    const actions = canEdit
      ? `<div class="news-card-actions">` +
        `<button class="news-icon-btn" data-edit="${p.id}" title="Редактировать"><i class="fas fa-pen"></i></button>` +
        `<button class="news-icon-btn" data-del="${p.id}" title="Удалить"><i class="fas fa-trash"></i></button></div>`
      : "";
    return `<article class="news-card${cover ? " has-cover" : ""}${p.is_pinned ? " pinned" : ""}" data-id="${p.id}">` +
      cover +
      `<div class="news-card-main">` +
      (p.is_pinned ? `<div class="news-pin-badge"><i class="fas fa-thumbtack"></i> Закреплено</div>` : "") +
      `<div class="news-card-top"><h2 class="news-card-title">${esc(p.title)}</h2>${actions}</div>` +
      `<div class="news-card-meta"><i class="fas fa-user"></i> ${esc(p.author)} · ${fmtDate(p.created_at)}` +
      (p.updated_at ? " · изменено" : "") + `</div>` +
      excerpt +
      `</div></article>`;
  }

  function render() {
    if (!posts.length) {
      feed.innerHTML = '<div class="news-empty">Пока нет новостей.</div>';
      return;
    }
    feed.innerHTML = posts.map(cardHtml).join("");
  }

  async function load() {
    try {
      const d = await api("/api/news");
      posts = d.items || [];
      render();
      maybeAutoEdit();
    } catch (e) {
      feed.innerHTML = '<div class="news-empty">Не удалось загрузить новости.</div>';
    }
  }

  // Клик по карточке → страница статьи; по кнопкам правки/удаления — действие.
  feed.addEventListener("click", (e) => {
    const edit = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-del]");
    if (edit) {
      e.preventDefault();
      const p = posts.find((x) => String(x.id) === edit.dataset.edit);
      if (p) openEditor(p);
      return;
    }
    if (del) {
      e.preventDefault();
      removePost(parseInt(del.dataset.del, 10));
      return;
    }
    const card = e.target.closest(".news-card");
    if (card && card.dataset.id) location.href = "/news/" + card.dataset.id;
  });

  if (!canEdit) { load(); return; }

  // ─────────────────────────── редактор ───────────────────────────
  const ov = $("newsEditorOv");
  const titleInput = $("newsTitleInput");
  const bodyInput = $("newsBodyInput");
  const pinInput = $("newsPinInput");
  const statusEl = $("newsEditorStatus");
  const imgFile = $("newsImgFile");
  const docFile = $("newsDocFile");

  let editingId = null;
  let savedRange = null;
  let pendingPoll = null;   // {question, description, allow_multiple, show_voters, options:[...]}
  let activeImg = null;     // выбранная в теле картинка (для выравнивания/подсветки)
  const pollPending = $("newsPollPending");

  function setActiveImg(img) {
    if (activeImg && activeImg !== img) activeImg.classList.remove("news-img-selected");
    activeImg = img || null;
    if (activeImg) activeImg.classList.add("news-img-selected");
  }

  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) {}

  function renderPollPending() {
    if (!pendingPoll) { pollPending.hidden = true; pollPending.innerHTML = ""; return; }
    pollPending.hidden = false;
    pollPending.innerHTML =
      '<div class="news-poll-pend-card"><div class="news-poll-pend-info">' +
      '<i class="fas fa-square-poll-vertical"></i> <b>Голосование:</b> ' + esc(pendingPoll.question) +
      ' <span class="news-poll-pend-cnt">(' + pendingPoll.options.length + ' вар.)</span></div>' +
      '<div class="news-poll-pend-act">' +
      '<button type="button" id="newsPollEdit" class="news-icon-btn" title="Изменить"><i class="fas fa-pen"></i></button>' +
      '<button type="button" id="newsPollDel" class="news-icon-btn" title="Убрать"><i class="fas fa-xmark"></i></button>' +
      '</div></div>';
    $("newsPollEdit").addEventListener("click", () => openPollModal(pendingPoll));
    $("newsPollDel").addEventListener("click", () => { pendingPoll = null; renderPollPending(); });
  }

  function setStatus(msg, kind) {
    if (!msg) { statusEl.hidden = true; return; }
    statusEl.hidden = false;
    statusEl.textContent = msg;
    statusEl.className = "news-editor-status" + (kind ? " " + kind : "");
  }

  function openEditor(post) {
    editingId = post ? post.id : null;
    $("newsEditorTitle").textContent = post ? "Редактирование новости" : "Новая новость";
    $("newsSaveBtn").textContent = post ? "Сохранить" : "Опубликовать";
    titleInput.value = post ? post.title : "";
    bodyInput.innerHTML = post ? (post.body_html || "") : "";
    pinInput.checked = !!(post && post.is_pinned);
    pendingPoll = post && post.poll ? post.poll : null;
    renderPollPending();
    setStatus("");
    ov.hidden = false;
    document.body.style.overflow = "hidden";
    titleInput.focus();
  }
  function closeEditor() {
    ov.hidden = true;
    document.body.style.overflow = "";
    editingId = null; savedRange = null; pendingPoll = null; activeImg = null;
  }

  $("newsAddBtn").addEventListener("click", () => openEditor(null));
  $("newsEditorClose").addEventListener("click", closeEditor);
  $("newsCancelBtn").addEventListener("click", closeEditor);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeEditor(); });

  // -- выделение (чтобы вставка/форматирование шли по месту курсора) --
  function saveSel() {
    const s = window.getSelection();
    if (s && s.rangeCount && bodyInput.contains(s.anchorNode)) savedRange = s.getRangeAt(0);
  }
  function restoreSel() {
    bodyInput.focus();
    if (savedRange) {
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(savedRange);
    }
  }
  bodyInput.addEventListener("keyup", saveSel);
  bodyInput.addEventListener("mouseup", saveSel);
  // Клик по картинке — выделить её (для выравнивания). Клик по тексту — снять выбор.
  bodyInput.addEventListener("click", (e) => setActiveImg(e.target.closest("img")));
  // Ввод текста снимает выбор картинки.
  bodyInput.addEventListener("input", () => { if (activeImg) setActiveImg(null); });

  // -- панель форматирования --
  const toolbar = $("newsToolbar");
  toolbar.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) e.preventDefault();  // не терять выделение
  });
  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.cmd) {
      restoreSel();
      document.execCommand(btn.dataset.cmd, false, null);
      saveSel();
    } else if (btn.dataset.block) {
      restoreSel();
      // Тумблер: повторный клик по заголовку/цитате возвращает обычный абзац.
      const cur = (document.queryCommandValue("formatBlock") || "").toLowerCase();
      const tag = btn.dataset.block;
      document.execCommand("formatBlock", false, cur === tag ? "<p>" : "<" + tag + ">");
      saveSel();
    } else if (btn.dataset.align) {
      setAlign(btn.dataset.align);
    }
  });

  // Выравнивание текущего блока классом (style режется санитайзером, поэтому классы).
  function currentBlock() {
    const s = window.getSelection();
    if (!s.rangeCount) return null;
    let n = s.anchorNode;
    n = n && n.nodeType === 1 ? n : (n ? n.parentElement : null);
    const blocks = ["P", "H2", "H3", "H4", "BLOCKQUOTE", "LI", "DIV", "FIGURE", "PRE"];
    while (n && n !== bodyInput) {
      if (blocks.includes(n.tagName)) return n;
      n = n.parentElement;
    }
    return null;
  }
  function setAlign(dir) {
    // Если выбрана картинка — выравниваем ЕЁ (она может лежать не в абзаце).
    if (activeImg) {
      activeImg.classList.remove("news-img-left", "news-img-center", "news-img-right", "news-img-full");
      const map = { left: "news-img-left", center: "news-img-center", right: "news-img-right", justify: "news-img-full" };
      activeImg.classList.add(map[dir]);
      return;
    }
    restoreSel();
    const b = currentBlock();
    if (!b) return;
    b.classList.remove("news-align-left", "news-align-center", "news-align-right", "news-align-justify");
    if (dir !== "left") b.classList.add("news-align-" + dir);   // left — по умолчанию
    saveSel();
  }

  $("newsLinkBtn").addEventListener("click", () => {
    const url = prompt("Адрес ссылки (https://…):", "https://");
    if (!url) return;
    restoreSel();
    document.execCommand("createLink", false, url);
    saveSel();
  });

  // -- выход из цитаты: двойной Enter на пустой строке завершает <blockquote> --
  function closestTag(tag) {
    const s = window.getSelection();
    if (!s.rangeCount) return null;
    let n = s.anchorNode;
    n = n && n.nodeType === 1 ? n : (n ? n.parentElement : null);
    while (n && n !== bodyInput) {
      if (n.tagName === tag) return n;
      n = n.parentElement;
    }
    return null;
  }
  let enterStreak = 0;
  bodyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      const bq = closestTag("BLOCKQUOTE");
      if (bq) {
        enterStreak += 1;
        if (enterStreak >= 2) {
          e.preventDefault();
          enterStreak = 0;
          // убрать пустую строку от первого Enter и выйти абзацем ПОСЛЕ цитаты
          while (bq.lastChild && (bq.lastChild.nodeName === "BR" ||
                 (bq.lastChild.nodeType === 3 && !bq.lastChild.textContent.trim()))) {
            bq.removeChild(bq.lastChild);
          }
          const p = document.createElement("p");
          p.appendChild(document.createElement("br"));
          bq.parentNode.insertBefore(p, bq.nextSibling);
          const r = document.createRange();
          r.setStart(p, 0); r.collapse(true);
          const s = window.getSelection();
          s.removeAllRanges(); s.addRange(r);
          saveSel();
        }
        return;
      }
    }
    enterStreak = 0;
  });

  // -- загрузка и ВСТАВКА по месту курсора картинок и документов --
  async function upload(file) {
    const fd = new FormData();
    fd.append("file", file);
    const d = await api("/api/news/upload", { method: "POST", body: fd });
    return d.media;
  }
  function insertAtCursor(html) {
    restoreSel();
    document.execCommand("insertHTML", false, html);
    saveSel();
  }

  $("newsImgBtn").addEventListener("click", () => { saveSel(); imgFile.click(); });
  imgFile.addEventListener("change", async () => {
    const f = imgFile.files[0];
    imgFile.value = "";
    if (!f) return;
    setStatus("Загрузка картинки…");
    try {
      const m = await upload(f);
      insertAtCursor(`<img src="${esc(m.url)}" alt="${esc(m.name)}">`);
      setStatus("");
    } catch (e) { setStatus("Не удалось загрузить: " + e.message, "err"); }
  });

  $("newsFileBtn").addEventListener("click", () => { saveSel(); docFile.click(); });
  docFile.addEventListener("change", async () => {
    const f = docFile.files[0];
    docFile.value = "";
    if (!f) return;
    setStatus("Загрузка документа…");
    try {
      const m = await upload(f);
      insertAtCursor(docCardHtml(m) + "&nbsp;");
      setStatus("");
    } catch (e) { setStatus("Не удалось загрузить: " + e.message, "err"); }
  });

  // -- сохранение --
  $("newsSaveBtn").addEventListener("click", async () => {
    setActiveImg(null);   // не сохранять подсветку выбранной картинки
    const title = titleInput.value.trim();
    const body_html = bodyInput.innerHTML.trim();
    if (!title && !body_html) {
      setStatus("Заполните заголовок или текст.", "err");
      return;
    }
    const payload = {
      title, body_html, attachments: [], is_pinned: pinInput.checked,
      poll: pendingPoll && pendingPoll.options && pendingPoll.options.length >= 2 ? pendingPoll : null,
    };
    setStatus("Сохранение…");
    try {
      const url = editingId ? "/api/news/" + editingId : "/api/news";
      await api(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      closeEditor();
      // Уберём ?edit из адреса, чтобы обновление страницы не открывало редактор.
      if (location.search) history.replaceState(null, "", "/news");
      load();
    } catch (e) { setStatus("Ошибка сохранения: " + e.message, "err"); }
  });

  async function removePost(id) {
    if (!confirm("Удалить эту новость? Действие необратимо.")) return;
    try {
      await api("/api/news/" + id, { method: "DELETE" });
      load();
    } catch (e) { alert("Не удалось удалить: " + e.message); }
  }

  // ─────────────────────────── редактор изображения ───────────────────────────
  // Двойной клик по картинке в теле — открыть редактор (обрезка/поворот/размер).
  bodyInput.addEventListener("dblclick", (e) => {
    const img = e.target.closest("img");
    if (img) { e.preventDefault(); openImageEditor(img); }
  });

  const ieOv = $("newsImgEditOv");
  const ieCanvas = $("ieCanvas");
  const ieStage = $("ieStage");
  const ieCropBox = $("ieCropBox");
  const ieScale = $("ieScale");
  let ieCtx = ieCanvas ? ieCanvas.getContext("2d") : null;
  let ieImg = null;          // рабочее изображение (Image)
  let ieTargetImg = null;    // <img> в теле, которое редактируем
  let ieCrop = null;         // {x,y,w,h} в координатах canvas (пиксели изображения)

  function ieStatus(msg, kind) {
    const el = $("newsImgEditStatus");
    if (!msg) { el.hidden = true; return; }
    el.hidden = false; el.textContent = msg;
    el.className = "news-editor-status" + (kind ? " " + kind : "");
  }
  function ieDraw() {
    if (!ieImg) return;
    ieCanvas.width = ieImg.naturalWidth || ieImg.width;
    ieCanvas.height = ieImg.naturalHeight || ieImg.height;
    ieCtx.clearRect(0, 0, ieCanvas.width, ieCanvas.height);
    ieCtx.drawImage(ieImg, 0, 0);
    // Вписать canvas в область просмотра по ширине.
    ieCropBox.hidden = true; ieCrop = null;
  }
  function loadIntoCanvas(src, cb) {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => { ieImg = im; ieDraw(); cb && cb(); };
    im.onerror = () => ieStatus("Не удалось загрузить изображение", "err");
    im.src = src;
  }
  function openImageEditor(img) {
    ieTargetImg = img;
    ieScale.value = 100; $("ieScaleVal").textContent = "100%";
    ieStatus("");
    ieOv.hidden = false;
    document.body.style.overflow = "hidden";
    loadIntoCanvas(img.src);
  }
  function closeImageEditor() {
    ieOv.hidden = true; document.body.style.overflow = "";
    ieImg = null; ieTargetImg = null; ieCrop = null;
  }
  $("newsImgEditClose").addEventListener("click", closeImageEditor);
  $("ieCancel").addEventListener("click", closeImageEditor);
  ieOv.addEventListener("mousedown", (e) => { if (e.target === ieOv) closeImageEditor(); });

  // Поворот на 90°.
  function rotate(dir) {
    if (!ieImg) return;
    const w = ieCanvas.width, h = ieCanvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = h; tmp.height = w;
    const tctx = tmp.getContext("2d");
    tctx.translate(h / 2, w / 2);
    tctx.rotate((dir === "r" ? 90 : -90) * Math.PI / 180);
    tctx.drawImage(ieCanvas, -w / 2, -h / 2);
    loadIntoCanvas(tmp.toDataURL("image/png"));
  }
  $("ieRotL").addEventListener("click", () => rotate("l"));
  $("ieRotR").addEventListener("click", () => rotate("r"));
  $("ieReset").addEventListener("click", () => { if (ieTargetImg) loadIntoCanvas(ieTargetImg.src, () => { ieScale.value = 100; $("ieScaleVal").textContent = "100%"; }); });

  // Выделение области обрезки мышью (координаты пересчитываем в пиксели canvas).
  function stageToCanvas(clientX, clientY) {
    const r = ieCanvas.getBoundingClientRect();
    const sx = ieCanvas.width / r.width, sy = ieCanvas.height / r.height;
    return { x: Math.max(0, Math.min(ieCanvas.width, (clientX - r.left) * sx)),
             y: Math.max(0, Math.min(ieCanvas.height, (clientY - r.top) * sy)) };
  }
  let cropDrag = null;
  ieStage.addEventListener("mousedown", (e) => {
    if (!ieImg || e.target.closest(".news-imgedit-crop")) return;
    const p = stageToCanvas(e.clientX, e.clientY);
    cropDrag = { x0: p.x, y0: p.y };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!cropDrag) return;
    const p = stageToCanvas(e.clientX, e.clientY);
    const x = Math.min(cropDrag.x0, p.x), y = Math.min(cropDrag.y0, p.y);
    const w = Math.abs(p.x - cropDrag.x0), h = Math.abs(p.y - cropDrag.y0);
    ieCrop = { x, y, w, h };
    // Отрисовать рамку поверх canvas в экранных координатах.
    const r = ieCanvas.getBoundingClientRect();
    const stageRect = ieStage.getBoundingClientRect();
    const scaleX = r.width / ieCanvas.width, scaleY = r.height / ieCanvas.height;
    ieCropBox.hidden = false;
    ieCropBox.style.left = (r.left - stageRect.left + x * scaleX) + "px";
    ieCropBox.style.top = (r.top - stageRect.top + y * scaleY) + "px";
    ieCropBox.style.width = (w * scaleX) + "px";
    ieCropBox.style.height = (h * scaleY) + "px";
  });
  window.addEventListener("mouseup", () => { cropDrag = null; });

  $("ieCrop").addEventListener("click", () => {
    if (!ieCrop || ieCrop.w < 5 || ieCrop.h < 5) { ieStatus("Сначала выделите область.", "err"); return; }
    const tmp = document.createElement("canvas");
    tmp.width = Math.round(ieCrop.w); tmp.height = Math.round(ieCrop.h);
    tmp.getContext("2d").drawImage(ieCanvas, ieCrop.x, ieCrop.y, ieCrop.w, ieCrop.h, 0, 0, tmp.width, tmp.height);
    loadIntoCanvas(tmp.toDataURL("image/png"));
    ieStatus("");
  });

  ieScale.addEventListener("input", () => { $("ieScaleVal").textContent = ieScale.value + "%"; });

  // Применить: масштабируем по ползунку, экспортируем, грузим как новое media, подменяем src.
  $("ieApply").addEventListener("click", async () => {
    if (!ieImg || !ieTargetImg) return;
    const scale = Math.max(0.1, Math.min(1, parseInt(ieScale.value, 10) / 100));
    const outW = Math.max(1, Math.round(ieCanvas.width * scale));
    const outH = Math.max(1, Math.round(ieCanvas.height * scale));
    const out = document.createElement("canvas");
    out.width = outW; out.height = outH;
    out.getContext("2d").drawImage(ieCanvas, 0, 0, outW, outH);
    ieStatus("Сохранение…");
    out.toBlob(async (blob) => {
      try {
        const ext = /png/i.test(blob.type) ? "png" : "jpg";
        const file = new File([blob], "image." + ext, { type: blob.type });
        const m = await upload(file);
        ieTargetImg.src = m.url;
        ieTargetImg.setAttribute("width", outW);   // ширина по горизонтали (высота — авто)
        ieTargetImg.removeAttribute("height");
        closeImageEditor();
      } catch (e) { ieStatus("Ошибка: " + e.message, "err"); }
    }, "image/png");
  });

  // ─────────────────────────── голосование ───────────────────────────
  const pollOv = $("newsPollOv");
  const npOpts = $("npOpts");
  function npAddRow(text) {
    const row = document.createElement("div");
    row.className = "msgr-poll-opt-edit";
    row.innerHTML = '<input class="msgr-poll-inp" maxlength="300" placeholder="Вариант ' +
      (npOpts.children.length + 1) + '"><button type="button" class="msgr-poll-rm" title="Убрать">&times;</button>';
    row.querySelector("input").value = text || "";
    row.querySelector(".msgr-poll-rm").addEventListener("click", () => {
      if (npOpts.children.length > 2) row.remove();
    });
    npOpts.appendChild(row);
  }
  function openPollModal(existing) {
    npOpts.innerHTML = "";
    $("npQ").value = existing ? existing.question : "";
    $("npD").value = existing ? (existing.description || "") : "";
    $("npMulti").checked = !!(existing && existing.allow_multiple);
    $("npVoters").checked = !!(existing && existing.show_voters);
    const opts = existing && existing.options && existing.options.length ? existing.options : ["", ""];
    opts.forEach((o) => npAddRow(o));
    while (npOpts.children.length < 2) npAddRow("");
    $("newsPollStatus").hidden = true;
    pollOv.hidden = false;
  }
  function closePollModal() { pollOv.hidden = true; }
  $("newsPollBtn").addEventListener("click", () => openPollModal(pendingPoll));
  $("npAdd").addEventListener("click", () => { if (npOpts.children.length < 12) npAddRow(""); });
  $("newsPollClose").addEventListener("click", closePollModal);
  $("npCancel").addEventListener("click", closePollModal);
  pollOv.addEventListener("mousedown", (e) => { if (e.target === pollOv) closePollModal(); });
  $("npOk").addEventListener("click", () => {
    const q = $("npQ").value.trim();
    const options = Array.from(npOpts.querySelectorAll("input")).map((i) => i.value.trim()).filter(Boolean);
    const st = $("newsPollStatus");
    if (!q) { st.hidden = false; st.className = "news-editor-status err"; st.textContent = "Введите вопрос."; return; }
    if (options.length < 2) { st.hidden = false; st.className = "news-editor-status err"; st.textContent = "Нужно минимум 2 варианта."; return; }
    pendingPoll = {
      question: q, description: $("npD").value.trim(),
      allow_multiple: $("npMulti").checked, show_voters: $("npVoters").checked,
      options,
    };
    renderPollPending();
    closePollModal();
  });

  // Переход «Редактировать» со страницы статьи: /news?edit=ID
  function maybeAutoEdit() {
    const id = new URLSearchParams(location.search).get("edit");
    if (!id) return;
    const p = posts.find((x) => String(x.id) === id);
    if (p) openEditor(p);
  }

  load();
})();
