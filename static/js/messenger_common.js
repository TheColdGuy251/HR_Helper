/* Общие утилиты мессенджера: рендер сообщений (группировка, ответы, вложения,
   выделение, закрепление), контекстное меню, лайтбокс изображений и контроллер
   взаимодействий (ПКМ-меню + выделение долгим зажатием). Используется мини-
   виджетом (messenger.js) и полной страницей (messenger_page.js). */
window.MsgrUI = (function () {
  "use strict";
  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s));
  const escAttr = (s) => (window.escapeAttr ? window.escapeAttr(s) : esc(s));
  const fmtTime = (iso) => {
    try { return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return ""; }
  };
  const GAP_MS = 10 * 60 * 1000;   // порог группировки/отступа — 10 минут

  function fileIcon(name) {
    const ext = (String(name).split(".").pop() || "").toLowerCase();
    if (ext === "pdf") return "fa-file-pdf";
    if (["doc", "docx", "odt", "rtf"].includes(ext)) return "fa-file-word";
    if (["xls", "xlsx", "ods", "csv"].includes(ext)) return "fa-file-excel";
    if (["ppt", "pptx"].includes(ext)) return "fa-file-powerpoint";
    if (["zip", "rar", "7z"].includes(ext)) return "fa-file-zipper";
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "fa-file-image";
    return "fa-file-lines";
  }
  const fmtSize = (b) => {
    b = b || 0;
    if (b < 1024) return b + " Б";
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " КБ";
    return (b / 1024 / 1024).toFixed(1) + " МБ";
  };

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand("copy"); ta.remove(); done && done();
    } catch (e) {}
  }
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done && done()).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }

  // ─────────── вложения ───────────
  // single=true — одиночная картинка в сообщении: резервируем место под неё
  // (ширина + aspect-ratio), чтобы до загрузки был серый прямоугольник и не дёргалась
  // прокрутка. Альбом/модалка резервируют место сеткой, им это не нужно.
  function imgHtml(a, single) {
    const dim = (a.w && a.h) ? ' width="' + a.w + '" height="' + a.h + '"' : "";
    let anchorStyle = "", imgStyle = "";
    if (single && a.w && a.h) {
      const scale = Math.min(240 / a.w, 320 / a.h, 1);
      anchorStyle = ' style="width:' + Math.max(1, Math.round(a.w * scale)) + 'px"';
      imgStyle = ' style="aspect-ratio:' + a.w + "/" + a.h + '"';
    }
    return '<a class="msgr-att-img" href="' + escAttr(a.url) + '" data-lightbox="1" data-name="' +
      escAttr(a.name) + '"' + (a.message_id ? ' data-mid="' + a.message_id + '"' : "") + ' data-copy="' + escAttr(a.url) + '"' + anchorStyle + ">" +
      '<img src="' + escAttr(a.url) + '" alt="' + esc(a.name) + '" loading="lazy"' + dim + imgStyle + "></a>";
  }
  function fileCardHtml(a) {
    return '<div class="chat-attachment msgr-att-file"' + (a.message_id ? ' data-mid="' + a.message_id + '"' : "") + ' data-copy="' + escAttr(a.url) + '">' +
      '<a class="chat-attachment-main" href="/messenger/files/' + escAttr(a.id) + '/view" target="_blank" rel="noopener" title="Открыть предпросмотр">' +
      '<div class="chat-attachment-icon"><i class="fas ' + fileIcon(a.name) + '"></i></div>' +
      '<div class="chat-attachment-body"><div class="chat-attachment-title">' + esc(a.name) + "</div>" +
      '<div class="chat-attachment-name">' + fmtSize(a.size) + "</div></div></a>" +
      '<a class="chat-attachment-action" href="' + escAttr(a.download_url) + '" title="Скачать" aria-label="Скачать"><i class="fas fa-download"></i></a>' +
      "</div>";
  }
  function attachmentsHtml(list) {
    if (!list || !list.length) return "";
    const imgs = list.filter((a) => a.is_image);
    const files = list.filter((a) => !a.is_image);
    let html = "";
    if (imgs.length === 1) {
      html += '<div class="msgr-atts">' + imgHtml(imgs[0], true) + "</div>";
    } else if (imgs.length > 1) {
      // Альбом: несколько картинок как одно сообщение (сетка по размерам).
      html += '<div class="msgr-album" data-count="' + imgs.length + '">' + imgs.map(imgHtml).join("") + "</div>";
    }
    if (files.length) html += '<div class="msgr-atts">' + files.map(fileCardHtml).join("") + "</div>";
    return html;
  }
  // Превью прикреплённых ПЕРЕД отправкой: миниатюры картинок + чипы файлов.
  function pendingAttsHtml(list) {
    return (list || []).map((a, i) => {
      if (a.is_image) {
        return '<span class="msgr-pend-img"><img src="' + escAttr(a.url) + '" alt="' + esc(a.name) + '">' +
          '<button data-rm="' + i + '" aria-label="Убрать">&times;</button></span>';
      }
      return '<span class="msgr-pend-chip"><i class="fas ' + fileIcon(a.name) + '"></i>' + esc(a.name) +
        '<button data-rm="' + i + '" aria-label="Убрать">&times;</button></span>';
    }).join("");
  }

  // Флаги группировки: grouped (тот же автор ≤10 мин от предыдущего) и gap (>10 мин).
  function groupFlag(prev, m) {
    if (!prev) return { grouped: false, gap: false };
    const dt = new Date(m.created_at) - new Date(prev.created_at);
    const same = prev.sender_id === m.sender_id && !prev.forwarded && !m.forwarded;
    if (dt > GAP_MS) return { grouped: false, gap: true };
    return { grouped: same, gap: false };
  }
  function computeGroupFlags(msgs) {
    return msgs.map((m, i) => groupFlag(msgs[i - 1], m));
  }

  // Галочка статуса для СВОИХ сообщений: пусто (отправка) / ! (ошибка) /
  // одна (доставлено) / двойная (просмотрено).
  function statusHtml(m) {
    if (!m.mine) return "";
    const s = m.status;
    if (s === "failed") return '<span class="msgr-tick failed" title="Не отправлено"><i class="fa-solid fa-exclamation"></i></span>';
    if (s === "sending") return '<span class="msgr-tick sending" title="Отправляется"></span>';
    if (s === "seen") return '<span class="msgr-tick seen" title="Просмотрено"><i class="fa-solid fa-check-double"></i></span>';
    return '<span class="msgr-tick" title="Доставлено"><i class="fa-solid fa-check"></i></span>';
  }
  // Время + пометка «(изм.)» + галочка ВНУТРИ пузыря (справа).
  function metaHtml(m, overlay) {
    const edited = m.is_edited ? '<span class="msgr-edited">(изм.)</span>' : "";
    return '<span class="msgr-meta' + (overlay ? " msgr-meta-ov" : "") + '">' + edited +
      '<span class="msgr-time">' + fmtTime(m.created_at) + "</span>" + statusHtml(m) + "</span>";
  }

  const REACTIONS = ["❤️", "🔥", "👍", "👎", "👌", "😢", "🤯"];
  function reactionsHtml(m) {
    if (!m.reactions || !m.reactions.length) return "";
    return '<div class="msgr-reactions">' + m.reactions.map((r) =>
      '<button class="msgr-reaction' + (r.mine ? " mine" : "") + '" data-emoji="' + escAttr(r.emoji) + '">' +
      '<span class="msgr-reaction-emoji">' + esc(r.emoji) + "</span>" +
      '<span class="msgr-reaction-count">' + r.count + "</span></button>").join("") + "</div>";
  }

  function voterAvatar(v, small) {
    return '<span class="msgr-voter-ava' + (small ? " sm" : "") + (v.is_bot ? " msgr-voter-bot" : "") +
      '" title="' + escAttr(v.name) + '">' + esc(v.initials || "?") + "</span>";
  }
  function pollHtml(p) {
    const opts = p.options.map((o) => {
      const pct = p.total_votes ? Math.round((o.votes / p.total_votes) * 100) : 0;
      const avatars = p.show_voters && o.voters && o.voters.length
        ? '<div class="msgr-poll-avatars">' + o.voters.slice(0, 6).map((v) => voterAvatar(v, true)).join("") +
          (o.voters.length > 6 ? '<span class="msgr-voter-more">+' + (o.voters.length - 6) + "</span>" : "") + "</div>" : "";
      return '<button class="msgr-poll-opt' + (o.mine ? " mine" : "") + '" data-opt="' + o.id + '">' +
        '<div class="msgr-poll-opt-head"><span class="msgr-poll-check"><i class="fa-solid ' +
        (o.mine ? "fa-circle-check" : "fa-circle") + '"></i></span>' +
        '<span class="msgr-poll-opt-text">' + esc(o.text) + "</span>" +
        '<span class="msgr-poll-opt-cnt">' + o.votes + " · " + pct + "%</span></div>" +
        '<div class="msgr-poll-bar"><div class="msgr-poll-bar-fill" style="width:' + pct + '%"></div></div>' +
        avatars + "</button>";
    }).join("");
    const sub = [p.total_votes + " " + plural(p.total_votes, "голос", "голоса", "голосов")];
    if (p.allow_multiple) sub.push("неск. ответов");
    if (p.show_voters) sub.push("открытое");
    return '<div class="msgr-poll" data-poll="' + p.id + '">' +
      '<div class="msgr-poll-q">' + esc(p.question) + "</div>" +
      (p.description ? '<div class="msgr-poll-desc">' + esc(p.description) + "</div>" : "") +
      '<div class="msgr-poll-card"><div class="msgr-poll-opts">' + opts + "</div></div>" +
      '<div class="msgr-poll-sub"><span>' + sub.join(" · ") + "</span>" +
      '<button class="msgr-poll-results" data-poll-results="' + p.id + '">Показать результаты</button></div>' +
      "</div>";
  }
  function plural(n, a, b, c) { n = Math.abs(n) % 100; const n1 = n % 10; if (n > 10 && n < 20) return c; if (n1 > 1 && n1 < 5) return b; if (n1 === 1) return a; return c; }

  // Модалка результатов голосования: кто за что проголосовал (ФИО + аватар).
  function pollResultsModal(p) {
    const ov = document.createElement("div");
    ov.className = "msgr-modal-ov";
    let body = "";
    p.options.forEach((o) => {
      const pct = p.total_votes ? Math.round((o.votes / p.total_votes) * 100) : 0;
      body += '<div class="msgr-res-opt"><div class="msgr-res-head"><span class="msgr-res-text">' + esc(o.text) +
        '</span><span class="msgr-res-cnt">' + o.votes + " · " + pct + "%</span></div>";
      if (p.show_voters) {
        const vs = o.voters || [];
        body += vs.length
          ? '<div class="msgr-res-voters">' + vs.map((v) => '<div class="msgr-res-voter">' + voterAvatar(v) + '<span>' + esc(v.name) + "</span></div>").join("") + "</div>"
          : '<div class="msgr-res-empty">Никто не выбрал</div>';
      }
      body += "</div>";
    });
    if (!p.show_voters) body += '<div class="msgr-res-empty">Голосование анонимное — показаны только числа.</div>';
    ov.innerHTML = '<div class="msgr-modal msgr-res-modal"><div class="msgr-modal-title">' + esc(p.question) + "</div>" +
      '<div class="msgr-res-body">' + body + "</div>" +
      '<div class="msgr-modal-actions"><button class="msgr-modal-cancel">Закрыть</button></div></div>';
    const close = () => ov.remove();
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.querySelector(".msgr-modal-cancel").addEventListener("click", close);
    document.body.appendChild(ov);
  }

  // opts: { general, grouped, gap, hideAvatar, noAnim }
  function buildMessageNode(m, opts) {
    opts = opts || {};
    const div = document.createElement("div");
    div.dataset.id = m.id;
    div._msg = m;

    // Системное сообщение (например, «X закрепил(а) сообщение») — серая строка по центру.
    if (m.system) {
      div.className = "message msgr-system msgr-noanim";
      div.innerHTML = '<div class="msgr-system-line">' + esc(m.sender_name) + " " + esc(m.content || "") + "</div>";
      return div;
    }

    const fwd = m.forwarded && m.forwarded_meta;
    const imgs = (m.attachments || []).filter((a) => a.is_image);
    const files = (m.attachments || []).filter((a) => !a.is_image);
    const mediaOnly = !fwd && !m.content && !m.poll && !m.reply_to && !m.forwarded_from && imgs.length && !files.length && !(opts.general && !m.mine);
    let content = "";

    if (fwd) {
      const fm = m.forwarded_meta;
      div.className = "message forwarded " + (m.mine ? "fwd-mine" : "fwd-peer");
      if (opts.general && !fm.ai) content += '<div class="msgr-fwd-caption"><i class="fa-solid fa-share"></i> Переслал: ' + (m.mine ? "Вы" : esc(m.sender_name)) + "</div>";
      if (m.reply_to) content += replyQuote(m.reply_to);
      if (m.content) content += '<div class="msgr-fwd-comment">' + esc(m.content) + "</div>";
      content += '<div class="msgr-fwd-label"><i class="fa-solid fa-robot"></i> HR-ассистент</div>';
      content += (window.MsgFmt
        ? window.MsgFmt.formatMessageContent(fm.content || "", fm.sources || [], true)
        : '<div class="msgr-msg-text">' + esc(fm.content) + "</div>");
      if (fm.attachment && window.MsgFmt) content += window.MsgFmt.renderAttachmentCard({ id: fm.attachment.id, title: fm.attachment.title, filename: fm.attachment.filename });
      content += metaHtml(m);
    } else {
      // В «Заметках» (self_chat) пересланное чужое сообщение показываем слева
      // зелёным пузырём (как входящее), несмотря на то что технически оно «своё».
      const notesFwd = m.self_chat && m.forwarded_from;
      div.className = "message " + (notesFwd ? "peer msgr-notes-fwd" : (m.mine ? "mine" : "peer"));
      if (opts.general && !m.mine) content += '<div class="msgr-msg-sender">' + esc(m.sender_name) + "</div>";
      // Плашка «Вопрос ассистенту» — сообщение является запросом к ИИ.
      if (m.is_ai_query) content += '<div class="msgr-ai-query-tag"><i class="fa-solid fa-robot"></i> Вопрос ассистенту</div>';
      // Пометка «Переслано от …» (сообщение переслано из другого чата).
      if (m.forwarded_from) content += fwdFromCaption(m.forwarded_from);
      if (m.reply_to) content += replyQuote(m.reply_to);
      if (m.poll) content += pollHtml(m.poll);
      // текст не дублируем, если это голосование (его вопрос уже в карточке)
      if (m.content && !m.poll) content += '<div class="msgr-msg-text">' + esc(m.content) + '<span class="msgr-meta-spacer' + (m.is_edited ? " edited" : "") + '"></span></div>';
      content += attachmentsHtml(m.attachments);
      // мета: оверлеем на картинке (медиа) или ставим в конце
      content += metaHtml(m, mediaOnly);
    }
    if (m.is_pinned) content = '<div class="msgr-pin-badge"><i class="fa-solid fa-thumbtack"></i></div>' + content;

    const notesFwdAva = m.self_chat && m.forwarded_from;
    const avatar = fwd ? "🤖"
      : (notesFwdAva ? esc((m.forwarded_from && m.forwarded_from.initials) || "?")
        : esc(m.mine ? "Я" : (m.sender_initials || "?")));
    if (opts.grouped) div.classList.add("grouped");
    if (opts.gap) div.classList.add("has-gap");
    if (opts.hideAvatar) div.classList.add("msgr-hide-avatar");   // аватар только у последнего в группе
    if (opts.noAnim) div.classList.add("msgr-noanim");            // перестройка (реакция/статус/правка) — без анимации
    // «plain» — простой текстовый пузырь либо только-картинка: время оверлеем в углу.
    // Если есть файлы/сложный контент — время идёт отдельной строкой.
    const plain = !fwd && !m.poll && (mediaOnly || !(m.attachments && m.attachments.length));
    if (plain) div.classList.add("msgr-plain");
    if (mediaOnly) div.classList.add("msgr-media-only");
    // Есть широкая подпись (Переслано от / ответ) + одиночная картинка → фиксируем
    // ширину картинки под подпись, чтобы пузырёк не был наполовину пустым.
    if (!fwd && imgs.length === 1 && !files.length && (m.forwarded_from || m.reply_to)) div.classList.add("msgr-wide-cap");

    div.innerHTML =
      '<span class="msgr-select-check"><i class="fa-solid fa-check"></i></span>' +
      '<div class="message-avatar">' + avatar + "</div>" +
      '<div class="message-wrapper">' +
        '<div class="message-content">' + content + "</div>" +
        reactionsHtml(m) +
      "</div>";
    return div;   // клики по реакциям/голосованию — через делегирование в attachThreadInteractions
  }
  buildMessageNode.REACTIONS = REACTIONS;

  function replyQuote(r) {
    return '<div class="msgr-reply-quote" data-reply-to="' + escAttr(r.id) + '">' +
      '<span class="msgr-reply-name">' + esc(r.sender_name) + "</span>" +
      '<span class="msgr-reply-text">' + esc(r.text) + "</span></div>";
  }

  // Пометка «Переслано от <аватар> Фамилия Имя» вверху пузыря.
  function fwdFromCaption(from) {
    return '<div class="msgr-fwd-from"><span class="msgr-fwd-from-label"><i class="fa-solid fa-share"></i> Переслано от</span>' +
      '<span class="msgr-fwd-from-ava">' + esc(from.initials || "?") + "</span>" +
      '<span class="msgr-fwd-from-name">' + esc(from.name || "—") + "</span></div>";
  }

  // Короткое превью сообщения для toast: текст или «🏞️ Изображение» / «📄 Документ».
  function attachLabel(m) {
    const atts = m.attachments || [];
    const imgs = atts.filter((a) => a.is_image);
    const docs = atts.filter((a) => !a.is_image);
    if (m.content) return (imgs.length ? "🏞️ " : docs.length ? "📄 " : "") + m.content;
    if (imgs.length) return "🏞️ " + (imgs.length === 1 ? "Изображение" : "Изображения");
    if (docs.length) return "📄 " + (docs.length === 1 ? "Документ" : "Документы");
    return "";
  }

  // Текст копирования сообщения.
  function messageText(m) {
    if (m.forwarded && m.forwarded_meta) return (m.content ? m.content + "\n\n" : "") + (m.forwarded_meta.content || "");
    let t = m.content || "";
    if (m.attachments && m.attachments.length) t += (t ? "\n" : "") + m.attachments.map((a) => "📎 " + a.name).join("\n");
    return t;
  }

  // Копирование нескольких сообщений с группировкой по отправителю: подряд идущие
  // сообщения одного автора собираются под его именем; смена автора — новая группа
  // (даже если он уже был выше). Группы разделяются пустой строкой.
  function groupedCopyText(msgs) {
    const groups = [];
    let cur = null;
    (msgs || []).forEach((m) => {
      const text = (messageText(m) || "").trim();
      if (!text) return;
      const name = m.sender_name || (m.mine ? "Вы" : "Отправитель");
      if (!cur || cur.name !== name) { cur = { name: name, lines: [] }; groups.push(cur); }
      cur.lines.push(text);
    });
    return groups.map((g) => g.name + ":\n" + g.lines.join("\n")).join("\n\n");
  }

  // ─────────── лайтбокс изображений (с листанием всех картинок чата) ───────────
  // images: [{url,name}], startIndex — с какой открыть. Стрелки на изображении,
  // клавиши ←/→ на десктопе, свайпы на мобильном.
  function imageLightbox(images, startIndex) {
    if (!Array.isArray(images)) images = [{ url: images, name: startIndex }], startIndex = 0;
    if (!images.length) return;
    let idx = Math.max(0, Math.min(startIndex || 0, images.length - 1));
    const multi = images.length > 1;
    const ov = document.createElement("div");
    ov.className = "msgr-lightbox";
    ov.innerHTML =
      '<button class="msgr-lightbox-close" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button>' +
      '<a class="msgr-lightbox-dl" title="Скачать"><i class="fa-solid fa-download"></i></a>' +
      (multi ? '<button class="msgr-lb-nav msgr-lb-prev" aria-label="Назад"><i class="fa-solid fa-chevron-left"></i></button>' : "") +
      '<img alt="">' +
      (multi ? '<button class="msgr-lb-nav msgr-lb-next" aria-label="Вперёд"><i class="fa-solid fa-chevron-right"></i></button>' : "") +
      (multi ? '<div class="msgr-lb-count"></div>' : "");
    const imgEl = ov.querySelector("img");
    const dl = ov.querySelector(".msgr-lightbox-dl");
    const cnt = ov.querySelector(".msgr-lb-count");
    function render() {
      const it = images[idx];
      imgEl.src = it.url; imgEl.alt = it.name || "";
      dl.href = it.url + (it.url.indexOf("?") >= 0 ? "&" : "?") + "download=1";
      if (cnt) cnt.textContent = (idx + 1) + " / " + images.length;
    }
    function go(delta) { idx = (idx + delta + images.length) % images.length; render(); }
    render();
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); else if (multi && e.key === "ArrowLeft") go(-1); else if (multi && e.key === "ArrowRight") go(1); };
    document.addEventListener("keydown", onKey);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.querySelector(".msgr-lightbox-close").addEventListener("click", (e) => { e.stopPropagation(); close(); });
    if (multi) {
      ov.querySelector(".msgr-lb-prev").addEventListener("click", (e) => { e.stopPropagation(); go(-1); });
      ov.querySelector(".msgr-lb-next").addEventListener("click", (e) => { e.stopPropagation(); go(1); });
      // свайпы (мобильные)
      let sx = null;
      ov.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; }, { passive: true });
      ov.addEventListener("touchend", (e) => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); });
    }
    document.body.appendChild(ov);
  }

  // ─────────── перехват «Назад» для оверлеев ───────────
  // На телефоне системная/браузерная кнопка «Назад» при открытом контекстном меню
  // или активном выделении должна ТОЛЬКО гасить их, а не уходить со страницы.
  // Реализуем через фиктивную запись в history: пока открыт оверлей — она в стеке,
  // «Назад» вызывает popstate → мы закрываем оверлей и остаёмся на месте.
  let _backArmed = false, _inPop = false;
  const _selChecks = new Set();    // isSelecting() контроллеров
  const _selClosers = new Set();   // exitSelection() контроллеров
  function _anyOverlay() {
    if (_menu) return true;
    for (const f of _selChecks) { try { if (f()) return true; } catch (e) {} }
    return false;
  }
  function syncBackTrap() {
    const open = _anyOverlay();
    if (open && !_backArmed) {
      _backArmed = true;
      try { history.pushState({ msgrOverlay: 1 }, ""); } catch (e) {}
    } else if (!open && _backArmed) {
      _backArmed = false;
      try { history.back(); } catch (e) {}   // снимаем фиктивную запись
    }
  }
  window.addEventListener("popstate", () => {
    if (!_backArmed) return;
    _backArmed = false;
    _inPop = true;
    if (_menu) closeMenu();
    for (const f of _selClosers) { try { f(); } catch (e) {} }
    _inPop = false;
  });

  // ─────────── контекстное меню (+ ряд реакций сверху) ───────────
  let _menu = null;
  function closeMenu() {
    if (_menu) { _menu.remove(); _menu = null; }
    if (!_inPop) syncBackTrap();
  }
  function showContextMenu(x, y, items, reactionRow) {
    closeMenu();
    const wrap = document.createElement("div");
    wrap.className = "msgr-ctx-wrap";
    if (reactionRow && reactionRow.emojis) {
      const emojis = reactionRow.emojis;
      const MAX = 4;                       // не более 4 реакций в ряду (5-я — стрелка)
      const rows = document.createElement("div");
      rows.className = "msgr-react-rows";
      const isActive = (em) => reactionRow.active && reactionRow.active.indexOf(em) >= 0;
      const addEmoji = (row, em) => {
        const b = document.createElement("button");
        b.className = "msgr-react-btn" + (isActive(em) ? " active" : "");
        b.textContent = em;
        b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); reactionRow.onPick(em); });
        row.appendChild(b);
      };
      const firstRow = document.createElement("div");
      firstRow.className = "msgr-react-row";
      emojis.slice(0, MAX).forEach((em) => addEmoji(firstRow, em));
      if (emojis.length > MAX) {
        // Скрытая область с остальными реакциями (раскрывается анимацией).
        const extra = document.createElement("div");
        extra.className = "msgr-react-extra";
        let row = null;
        emojis.slice(MAX).forEach((em, i) => {
          if (i % MAX === 0) { row = document.createElement("div"); row.className = "msgr-react-row"; extra.appendChild(row); }
          addEmoji(row, em);
        });
        // Стрелка — переключатель раскрытия/сжатия (с анимацией переворота).
        const more = document.createElement("button");
        more.className = "msgr-react-btn msgr-react-more";
        more.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          const opened = extra.classList.toggle("open");
          more.classList.toggle("rotated", opened);
          requestAnimationFrame(() => {
            const r = wrap.getBoundingClientRect();
            if (r.bottom > window.innerHeight) wrap.style.top = Math.max(8, window.innerHeight - r.height - 8) + "px";
          });
        });
        firstRow.appendChild(more);
        rows.appendChild(firstRow);
        rows.appendChild(extra);
      } else {
        rows.appendChild(firstRow);
      }
      wrap.appendChild(rows);
    }
    const menu = document.createElement("div");
    menu.className = "msgr-ctx-menu";
    for (const it of items) {
      if (it.sep) { const s = document.createElement("div"); s.className = "msgr-ctx-sep"; menu.appendChild(s); continue; }
      const b = document.createElement("button");
      b.className = "msgr-ctx-item" + (it.danger ? " danger" : "");
      b.innerHTML = '<i class="fa-solid ' + it.icon + '"></i><span>' + esc(it.label) + "</span>";
      b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(); });
      menu.appendChild(b);
    }
    wrap.appendChild(menu);
    wrap.style.visibility = "hidden";
    document.body.appendChild(wrap);
    const r = wrap.getBoundingClientRect();
    wrap.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
    wrap.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
    wrap.style.visibility = "";
    _menu = wrap;
    if (!_inPop) syncBackTrap();       // «Назад» теперь закрывает меню, а не уходит
    setTimeout(() => {
      const off = (e) => {
        if (_menu && !_menu.contains(e.target)) {
          closeMenu();
          document.removeEventListener("mousedown", off);
          document.removeEventListener("touchstart", off);
          document.removeEventListener("wheel", off);
        }
      };
      document.addEventListener("mousedown", off);
      document.addEventListener("touchstart", off, { passive: true });
      document.addEventListener("wheel", off, { passive: true });
    }, 0);
  }

  // ─────────── контроллер взаимодействий (ПКМ + выделение) ───────────
  // ctx: { container, isGeneral(), menuItems(m)->[], onLongPressSelect(),
  //        toolbar:{el,count,copy,fwd,del,cancel}, onCopy(msgs), onForward(msgs),
  //        onDelete(msgs) }
  function attachThreadInteractions(ctx) {
    const cont = ctx.container;
    const selected = new Set();       // id
    let selMode = false, dragging = false, suppressClick = false;
    let start = null, decided = null;   // жест: null | 'text' | 'select'

    const isMsg = (n) => n && n.dataset && n.dataset.id && !n.classList.contains("msgr-typing");
    function msgAtY(y) {
      const nodes = cont.querySelectorAll(".message[data-id]");
      for (const n of nodes) {
        if (n.classList.contains("msgr-typing")) continue;
        const r = n.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom) return n;
      }
      return null;
    }
    function clearTextSel() { try { const s = window.getSelection(); if (s) s.removeAllRanges(); } catch (e) {} }

    function updateToolbar() {
      if (!ctx.toolbar) return;
      ctx.toolbar.el.hidden = !(selMode && selected.size);
      if (ctx.toolbar.count) ctx.toolbar.count.textContent = selected.size;
    }
    function paint() {
      cont.querySelectorAll(".message").forEach((n) => n.classList.toggle("is-selected", selected.has(n.dataset.id)));
    }
    function enterSelection() { selMode = true; cont.classList.add("selecting"); updateToolbar(); if (!_inPop) syncBackTrap(); }
    function exitSelection() { selMode = false; selected.clear(); cont.classList.remove("selecting"); paint(); updateToolbar(); if (!_inPop) syncBackTrap(); }
    function toggle(node) {
      const id = node.dataset.id;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      paint(); updateToolbar();
    }
    function selectedMsgs() {
      const out = [];
      cont.querySelectorAll(".message").forEach((n) => { if (selected.has(n.dataset.id) && n._msg) out.push(n._msg); });
      return out;
    }

    // Клик по цитате ответа → перейти к исходному сообщению.
    cont.addEventListener("click", (e) => {
      const rq = e.target.closest(".msgr-reply-quote");
      if (rq && !selMode) { e.preventDefault(); scrollToMessage(cont, rq.dataset.replyTo); return; }
    });
    // Лайтбокс по изображению — можно листать ВСЕ картинки чата.
    cont.addEventListener("click", (e) => {
      const img = e.target.closest(".msgr-att-img");
      if (!img || selMode) return;
      e.preventDefault();
      const nodes = Array.prototype.slice.call(cont.querySelectorAll(".msgr-att-img"));
      const all = nodes.map((a) => ({ url: a.getAttribute("href"), name: a.dataset.name }));
      imageLightbox(all, nodes.indexOf(img));
    });
    // Реакции и варианты голосования.
    cont.addEventListener("click", (e) => {
      if (selMode) return;
      const rb = e.target.closest(".msgr-reaction");
      if (rb) { e.preventDefault(); e.stopPropagation(); const n = rb.closest(".message"); if (n && n._msg && ctx.onReact) ctx.onReact(n._msg, rb.dataset.emoji); return; }
      const rr = e.target.closest(".msgr-poll-results");
      if (rr) { e.preventDefault(); e.stopPropagation(); const n = rr.closest(".message"); if (n && n._msg && n._msg.poll) pollResultsModal(n._msg.poll); return; }
      const pb = e.target.closest(".msgr-poll-opt");
      if (pb) { e.preventDefault(); e.stopPropagation(); const n = pb.closest(".message"); if (n && n._msg && ctx.onVote) ctx.onVote(n._msg, parseInt(pb.dataset.opt, 10)); return; }
    });
    // ЛКМ в режиме выделения — переключаем сообщение (по всей ширине строки).
    cont.addEventListener("click", (e) => {
      if (suppressClick) { suppressClick = false; return; }
      if (!selMode) return;
      if (e.target.closest("a, button, .msg-edit-box")) return;
      const n = e.target.closest(".message[data-id]") || msgAtY(e.clientY);
      if (isMsg(n)) { e.preventDefault(); toggle(n); }
    });

    function openMenuFor(n, x, y) {
      const items = ctx.menuItems(n._msg, n, {
        startSelect: () => { enterSelection(); selected.add(n.dataset.id); paint(); updateToolbar(); },
      });
      const reactionRow = (ctx.onReact && !n._msg.system) ? { emojis: REACTIONS, active: (n._msg.reactions || []).filter((r) => r.mine).map((r) => r.emoji), onPick: (em) => ctx.onReact(n._msg, em) } : null;
      showContextMenu(x, y, items, reactionRow);
    }

    // ПКМ — контекстное меню + ряд реакций. На тач-устройствах контекстное меню
    // вызывается одиночным касанием (см. ниже), поэтому нативный long-press →
    // contextmenu подавляем, чтобы он не дублировал/не мешал режиму выделения.
    cont.addEventListener("contextmenu", (e) => {
      if (touchActive) { e.preventDefault(); return; }
      const n = e.target.closest(".message[data-id]") || msgAtY(e.clientY);
      if (!isMsg(n)) return;
      e.preventDefault();
      openMenuFor(n, e.clientX, e.clientY);
    });

    // В режиме выделения запрещаем выделение текста (иначе всплывает окно браузера).
    cont.addEventListener("selectstart", (e) => { if (selMode) e.preventDefault(); });

    // Жест МЫШЬЮ (десктоп): определяем направление движения.
    //  • по горизонтали или по вертикали В ПРЕДЕЛАХ пузыря → выделение ТЕКСТА (native);
    //  • по вертикали ЗА ПРЕДЕЛЫ пузыря → режим выделения СООБЩЕНИЙ.
    // Тач обрабатывается отдельно (touchstart/move/end ниже): касание → меню,
    // долгое нажатие → выделение с протяжкой. Поэтому здесь пропускаем тач-указатели.
    cont.addEventListener("pointerdown", (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      if (e.button === 2 || e.target.closest("a, button, input, textarea, .msg-edit-box")) { start = null; return; }
      const n = e.target.closest(".message[data-id]") || msgAtY(e.clientY);
      if (!isMsg(n)) { start = null; return; }
      const r = n.getBoundingClientRect();
      start = { node: n, x: e.clientX, y: e.clientY, top: r.top, bottom: r.bottom };
      decided = selMode ? "select" : null;
      dragging = selMode;
    });
    cont.addEventListener("pointermove", (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      if (!start) return;
      if (dragging) {
        const n = msgAtY(e.clientY);
        if (isMsg(n) && !selected.has(n.dataset.id)) { selected.add(n.dataset.id); paint(); updateToolbar(); }
        return;
      }
      // Выход за вертикальные границы пузыря → режим выделения сообщений
      // (даже если уже начали выделять текст внутри пузыря).
      const outsideBubble = e.clientY < start.top - 3 || e.clientY > start.bottom + 3;
      if (outsideBubble) {
        decided = "select"; suppressClick = true;
        if (!selMode) enterSelection();
        selected.add(start.node.dataset.id);
        const cur = msgAtY(e.clientY); if (cur) selected.add(cur.dataset.id);
        dragging = true; clearTextSel(); paint(); updateToolbar();
        return;
      }
      if (decided === "text") return;
      const dx = Math.abs(e.clientX - start.x), dy = Math.abs(e.clientY - start.y);
      if (dx > 4 || dy > 4) decided = "text";   // вбок/внутри пузыря — выделяем текст
    });
    const endGesture = () => { start = null; decided = null; dragging = false; };
    cont.addEventListener("pointerup", endGesture);
    cont.addEventListener("pointercancel", endGesture);

    // ─────────── ТАЧ-логика (телефоны/планшеты) ───────────
    // Одиночное касание сообщения → контекстное меню. Долгое нажатие → режим
    // выделения: удерживая палец и двигая его вверх/вниз, выделяем задетые
    // сообщения; у верхнего/нижнего края ленты включается автопрокрутка.
    const LONG_MS = 420, TAP_MOVE = 12, EDGE = 66, EDGE_SPEED = 16;
    let touchActive = false;
    let tStart = null, tLong = false, tTimer = null, tRAF = null;
    const INTERACTIVE = "a, button, input, textarea, .msg-edit-box, .msgr-att-img, " +
      ".msgr-poll-opt, .msgr-poll-results, .msgr-reaction, .msgr-reply-quote, " +
      // кликабельные элементы /chat (тап по ним не должен открывать меню/выделение)
      ".md-sources-more, .md-src-ref, .chat-clarify-opt, .faq-chip, .chat-fwd-item";

    function stopAutoScroll() { if (tRAF) { cancelAnimationFrame(tRAF); tRAF = null; } }
    function autoScrollTick() {
      if (!tLong || !tStart) { tRAF = null; return; }
      const y = tStart.lastY;
      const r = cont.getBoundingClientRect();
      let dy = 0;
      if (y < r.top + EDGE) dy = -EDGE_SPEED * Math.min(1, (r.top + EDGE - y) / EDGE);
      else if (y > r.bottom - EDGE) dy = EDGE_SPEED * Math.min(1, (y - (r.bottom - EDGE)) / EDGE);
      if (dy) {
        cont.scrollTop += dy;
        const n = msgAtY(y);
        if (isMsg(n) && !selected.has(n.dataset.id)) { selected.add(n.dataset.id); paint(); updateToolbar(); }
      }
      tRAF = requestAnimationFrame(autoScrollTick);
    }
    function resetTouch() {
      clearTimeout(tTimer); tTimer = null;
      tStart = null; tLong = false; stopAutoScroll();
    }

    cont.addEventListener("touchstart", (e) => {
      if (e.touches.length > 1) { resetTouch(); return; }
      touchActive = true;
      // Если открыто контекстное меню — касание только ЗАКРЫВАЕТ его (закроет внешний
      // обработчик по touchstart, он срабатывает следом), новое меню/выделение не
      // запускаем. Обработчик .message выполняется раньше документного, поэтому здесь
      // _menu ещё установлен.
      if (_menu) { tStart = null; return; }
      const t = e.touches[0];
      if (e.target.closest(INTERACTIVE)) { tStart = null; return; }
      const n = e.target.closest(".message[data-id]") || msgAtY(t.clientY);
      if (!isMsg(n)) { tStart = null; return; }
      tStart = { node: n, x: t.clientX, y: t.clientY, lastY: t.clientY, t: Date.now(), scroll0: cont.scrollTop };
      tLong = false;
      clearTimeout(tTimer);
      tTimer = setTimeout(() => {
        // Не включаем выделение, если за время удержания лента прокрутилась
        // (пользователь листает сообщения, а не выделяет).
        if (!tStart || Math.abs(cont.scrollTop - tStart.scroll0) > 4) { tStart = null; return; }
        tLong = true;                         // долгое нажатие → выделение
        if (!selMode) enterSelection();
        selected.add(tStart.node.dataset.id); paint(); updateToolbar();
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) {} }
        if (!tRAF) tRAF = requestAnimationFrame(autoScrollTick);
      }, LONG_MS);
    }, { passive: true });

    cont.addEventListener("touchmove", (e) => {
      if (!tStart) return;
      const t = e.touches[0];
      tStart.lastY = t.clientY;
      if (!tLong) {
        // Двинули палец или лента прокрутилась до срабатывания долгого нажатия →
        // это прокрутка, а не выделение: отменяем таймер.
        if (Math.abs(t.clientX - tStart.x) > TAP_MOVE ||
            Math.abs(t.clientY - tStart.y) > TAP_MOVE ||
            Math.abs(cont.scrollTop - tStart.scroll0) > 4) {
          clearTimeout(tTimer); tStart = null;
        }
        return;
      }
      // Режим выделения активен — тянем выделение и гасим нативную прокрутку.
      e.preventDefault();
      const n = msgAtY(t.clientY);
      if (isMsg(n) && !selected.has(n.dataset.id)) { selected.add(n.dataset.id); paint(); updateToolbar(); }
    }, { passive: false });

    cont.addEventListener("touchend", (e) => {
      clearTimeout(tTimer); tTimer = null; stopAutoScroll();
      setTimeout(() => { touchActive = false; }, 400);
      if (!tStart) return;
      const wasLong = tLong;
      const t = e.changedTouches && e.changedTouches[0];
      const dist = t ? Math.hypot(t.clientX - tStart.x, t.clientY - tStart.y) : 0;
      const dt = Date.now() - tStart.t;
      const node = tStart.node;
      tStart = null; tLong = false;
      // preventDefault гасит синтетические mouse-события (иначе mousedown тут же
      // закрыл бы только что открытое меню, а click — сбросил бы выделение).
      if (wasLong) { if (e.cancelable) e.preventDefault(); suppressClick = true; return; }
      if (dist > TAP_MOVE || dt > 700) return;         // это была прокрутка/удержание
      if (e.cancelable) e.preventDefault();
      suppressClick = true;
      if (selMode) { toggle(node); return; }           // в режиме выделения — тап переключает
      openMenuFor(node, t ? t.clientX : 0, t ? t.clientY : 0);
    }, { passive: false });

    cont.addEventListener("touchcancel", () => { resetTouch(); touchActive = false; });

    // Esc — отмена выделения
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selMode) exitSelection(); });

    // Панель выделения
    if (ctx.toolbar) {
      ctx.toolbar.copy && ctx.toolbar.copy.addEventListener("click", () => { ctx.onCopy && ctx.onCopy(selectedMsgs()); exitSelection(); });
      ctx.toolbar.fwd && ctx.toolbar.fwd.addEventListener("click", () => { const m = selectedMsgs(); exitSelection(); ctx.onForward && ctx.onForward(m); });
      ctx.toolbar.del && ctx.toolbar.del.addEventListener("click", () => { ctx.onDelete && ctx.onDelete(selectedMsgs()); });
      ctx.toolbar.cancel && ctx.toolbar.cancel.addEventListener("click", exitSelection);
    }

    // Регистрируем состояние выделения этого контроллера в общем перехватчике
    // «Назад» (создаётся один раз на страницу — снимать регистрацию не нужно).
    _selChecks.add(() => selMode);
    _selClosers.add(exitSelection);

    // Закрывает открытые «оверлеи» (контекстное меню и/или режим выделения).
    // Возвращает true, если что-то было закрыто — чтобы кнопка «Назад» в этом
    // случае ТОЛЬКО гасила их, а не уходила со страницы.
    function closeOverlays() {
      let did = false;
      if (_menu) { closeMenu(); did = true; }
      if (selMode) { exitSelection(); did = true; }
      return did;
    }

    return { exitSelection, isSelecting: () => selMode, closeOverlays };
  }

  // Встроенное редактирование своего сообщения (стиль /chat).
  function editMessage(node, m, onSave) {
    const contentEl = node.querySelector(".message-content");
    if (!contentEl || node.querySelector(".msg-edit-box")) return;
    const raw = m.content || "";
    contentEl.style.display = "none";
    node.classList.add("editing");
    const box = document.createElement("div");
    box.className = "msg-edit-box";
    box.innerHTML =
      '<textarea class="msg-edit-input" aria-label="Изменить сообщение"></textarea>' +
      '<div class="msg-edit-actions">' +
        '<button type="button" class="msg-edit-cancel">Отмена</button>' +
        '<button type="button" class="msg-edit-save">Сохранить</button>' +
      "</div>";
    node.querySelector(".message-wrapper").appendChild(box);
    const ta = box.querySelector(".msg-edit-input");
    ta.value = raw;
    const resize = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 200) + "px"; };
    resize(); ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
    const close = () => { box.remove(); node.classList.remove("editing"); contentEl.style.display = ""; };
    const save = () => { const v = ta.value.trim(); close(); if (v && v !== raw) onSave(v); };
    ta.addEventListener("input", resize);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    box.querySelector(".msg-edit-cancel").addEventListener("click", close);
    box.querySelector(".msg-edit-save").addEventListener("click", save);
  }

  // Шапка «Закреплённое сообщение» (стиль Telegram). Показывает последнее
  // закреплённое; клик — переход к нему, крестик — открепить.
  function updatePinnedBar(barEl, cont, handlers) {
    if (!barEl) return;
    const pinnedNodes = [];
    cont.querySelectorAll(".message[data-id]").forEach((n) => { if (n._msg && n._msg.is_pinned) pinnedNodes.push(n._msg); });
    if (!pinnedNodes.length) { barEl.hidden = true; barEl.innerHTML = ""; return; }
    const p = pinnedNodes[pinnedNodes.length - 1];
    let text = p.forwarded ? "Сообщение ассистента" : (p.content || (p.attachments && p.attachments.length ? "📎 вложение" : ""));
    barEl.hidden = false;
    barEl.innerHTML =
      '<div class="msgr-pinbar-accent"></div>' +
      '<div class="msgr-pinbar-body">' +
        '<div class="msgr-pinbar-title"><i class="fa-solid fa-thumbtack"></i> Закреплённое сообщение</div>' +
        '<div class="msgr-pinbar-text">' + esc(text) + "</div>" +
      "</div>" +
      '<button class="msgr-pinbar-unpin" title="Открепить"><i class="fa-solid fa-xmark"></i></button>';
    barEl.querySelector(".msgr-pinbar-body").addEventListener("click", () => handlers.onJump && handlers.onJump(p.id));
    barEl.querySelector(".msgr-pinbar-unpin").addEventListener("click", (e) => { e.stopPropagation(); handlers.onUnpin && handlers.onUnpin(p); });
  }

  // Прокрутка к сообщению (или подсветка, если оно уже видно).
  function scrollToMessage(cont, id) {
    const n = cont.querySelector('[data-id="' + id + '"]');
    if (!n) return;
    const cr = cont.getBoundingClientRect(), nr = n.getBoundingClientRect();
    const visible = nr.top >= cr.top && nr.bottom <= cr.bottom;
    if (!visible) n.scrollIntoView({ behavior: "smooth", block: "center" });
    // Анимация самого пузырька (осветление) — на .message-content, чтобы не
    // задевать анимацию появления сообщения (fadeIn).
    const bubble = n.querySelector(".message-content") || n;
    bubble.classList.remove("msgr-flash-anim");
    void bubble.offsetWidth;
    bubble.classList.add("msgr-flash-anim");
    setTimeout(() => bubble.classList.remove("msgr-flash-anim"), 1400);
    // Плавное подсвечивание и исчезание выделения ВСЕЙ СТРОКИ (голубая полоса).
    // Двухфазно: сначала фон появляется (transition), затем гаснет, и только потом
    // снимаем width — так исчезание тоже плавное.
    n.classList.add("msgr-flash-select");
    setTimeout(() => n.classList.add("msgr-flash-out"), 950);
    setTimeout(() => n.classList.remove("msgr-flash-select", "msgr-flash-out"), 1350);
  }

  // Превью документа (pdf/txt/изображение — в модалке; иначе — скачать/открыть).
  function filePreview(url, name) {
    const clean = (url || "").split("?")[0];
    const ext = (clean.split(".").pop() || "").toLowerCase();
    const previewable = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "txt", "md", "csv"].includes(ext);
    if (!previewable) { window.open(url, "_blank", "noopener"); return; }
    const ov = document.createElement("div");
    ov.className = "msgr-lightbox msgr-doc-preview";
    const inner = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)
      ? '<img src="' + escAttr(url) + '" alt="' + esc(name || "") + '">'
      : '<iframe src="' + escAttr(url) + '" title="' + esc(name || "") + '"></iframe>';
    ov.innerHTML =
      '<button class="msgr-lightbox-close" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button>' +
      '<a class="msgr-lightbox-dl" href="' + escAttr(url) + '?download=1" title="Скачать"><i class="fa-solid fa-download"></i></a>' +
      '<div class="msgr-doc-frame">' + inner + "</div>";
    const close = () => ov.remove();
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.querySelector(".msgr-lightbox-close").addEventListener("click", close);
    document.addEventListener("keydown", function onKey(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } });
    document.body.appendChild(ov);
  }

  // Модалка подтверждения удаления. allowForAll=true → показываем чекбокс
  // «Удалить для всех» (только когда все выбранные — свои). Иначе спрашиваем
  // «Удалить у меня?» (чужие можно удалять только у себя).
  function confirmDelete(count, allowForAll, cb) {
    const ov = document.createElement("div");
    ov.className = "msgr-modal-ov";
    const title = allowForAll
      ? "Удалить " + (count > 1 ? "сообщения (" + count + ")?" : "сообщение?")
      : "Удалить у меня?";
    const checkHtml = allowForAll
      ? '<label class="msgr-modal-check"><input type="checkbox" id="msgrDelAll"> Удалить для всех</label>'
      : '<div class="msgr-modal-note">Чужие сообщения удаляются только у вас.</div>';
    ov.innerHTML =
      '<div class="msgr-modal">' +
        '<div class="msgr-modal-title">' + title + "</div>" +
        checkHtml +
        '<div class="msgr-modal-actions">' +
          '<button class="msgr-modal-cancel">Отмена</button>' +
          '<button class="msgr-modal-ok">Удалить</button>' +
        "</div>" +
      "</div>";
    const close = () => ov.remove();
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.querySelector(".msgr-modal-cancel").addEventListener("click", close);
    ov.querySelector(".msgr-modal-ok").addEventListener("click", () => {
      const forAll = allowForAll && ov.querySelector("#msgrDelAll").checked;
      close(); cb(forAll);
    });
    document.body.appendChild(ov);
  }

  // Текст «X печатает» / «X, Y, Z и другие печатают» (до 3 имён).
  function typingLabel(names) {
    names = (names || []).filter(Boolean);
    if (!names.length) return "";
    const verb = names.length === 1 ? "печатает" : "печатают";
    if (names.length <= 3) return names.join(", ") + " " + verb;
    return names.slice(0, 3).join(", ") + " и другие печатают";
  }
  function buildTypingNode(opts) {
    opts = opts || {};
    const div = document.createElement("div");
    div.className = "message peer msgr-typing";
    div.dataset.typing = "1";
    const label = opts.label ? '<span class="msgr-typing-label">' + esc(opts.label) + "</span>" : "";
    div.innerHTML =
      '<div class="message-avatar">' + (opts.avatar || "?") + "</div>" +
      '<div class="message-wrapper"><div class="msgr-typing-wrap">' +
        '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>' +
        label +
      "</div></div>";
    return div;
  }

  // Именительный падеж — для заголовков месяцев («Июль 2026», не «Июля 2026»).
  const _MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  // Группировка элементов по месяцам (по created_at), сохраняя исходный порядок.
  function groupByMonth(items) {
    const groups = [];
    const idx = {};
    for (const it of items) {
      const d = it.created_at ? new Date(it.created_at) : new Date();
      const key = d.getFullYear() + "-" + d.getMonth();
      const label = _MONTHS[d.getMonth()] + " " + d.getFullYear();
      if (!(key in idx)) { idx[key] = groups.length; groups.push({ label, items: [] }); }
      groups[idx[key]].items.push(it);
    }
    return groups;
  }
  function monthSections(items, itemHtml, wrapClass) {
    return groupByMonth(items).map((g) =>
      '<div class="msgr-att-month">' + esc(g.label) + "</div>" +
      '<div class="' + wrapClass + '">' + g.items.map(itemHtml).join("") + "</div>"
    ).join("");
  }

  // Модалка «Вложения диалога» с вкладками: Документы / Медиа / Ссылки.
  // onGoToMessage(id) — переход к сообщению (по контекстному меню вложения).
  function attachmentsModal(data, onGoToMessage) {
    const ov = document.createElement("div");
    ov.className = "msgr-modal-ov";
    const media = data.media || [], docs = data.documents || [], links = data.links || [];
    const linkCard = (l) => '<a class="msgr-att-link" href="' + escAttr(l.url) + '" target="_blank" rel="noopener" data-mid="' + (l.message_id || "") + '" data-copy="' + escAttr(l.url) + '"><i class="fa-solid fa-link"></i><span>' + esc(l.url) + "</span></a>";
    // Поиск (только Документы и Ссылки): пустой запрос → всё, иначе фильтр по имени/URL.
    function docsPane(q) {
      if (!docs.length) return '<div class="msgr-att-empty">Нет документов</div>';
      const f = q ? docs.filter((d) => (d.name || "").toLowerCase().indexOf(q) >= 0) : docs;
      return f.length ? monthSections(f, fileCardHtml, "msgr-att-list") : '<div class="msgr-att-empty">Ничего не найдено</div>';
    }
    function linksPane(q) {
      if (!links.length) return '<div class="msgr-att-empty">Нет ссылок</div>';
      const f = q ? links.filter((l) => (l.url || "").toLowerCase().indexOf(q) >= 0) : links;
      return f.length ? '<div class="msgr-att-list">' + f.map(linkCard).join("") + "</div>" : '<div class="msgr-att-empty">Ничего не найдено</div>';
    }
    const mediaHtml = media.length ? monthSections(media, (a) => imgHtml(a), "msgr-att-grid") : '<div class="msgr-att-empty">Нет медиафайлов</div>';
    ov.innerHTML =
      '<div class="msgr-modal msgr-att-modal">' +
        '<div class="msgr-att-tabs">' +
          '<button class="msgr-att-tab active" data-tab="docs">Документы' + (docs.length ? " · " + docs.length : "") + "</button>" +
          '<button class="msgr-att-tab" data-tab="media">Медиа' + (media.length ? " · " + media.length : "") + "</button>" +
          '<button class="msgr-att-tab" data-tab="links">Ссылки' + (links.length ? " · " + links.length : "") + "</button>" +
          '<button class="msgr-att-close" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button>' +
        "</div>" +
        '<div class="msgr-att-search"><i class="fa-solid fa-magnifying-glass"></i>' +
          '<input type="text" placeholder="Поиск по названию…"></div>' +
        '<div class="msgr-att-body">' +
          '<div class="msgr-att-pane" data-pane="docs">' + docsPane("") + "</div>" +
          '<div class="msgr-att-pane" data-pane="media" hidden>' + mediaHtml + "</div>" +
          '<div class="msgr-att-pane" data-pane="links" hidden>' + linksPane("") + "</div>" +
        "</div>" +
      "</div>";
    const close = () => ov.remove();
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.querySelector(".msgr-att-close").addEventListener("click", close);
    const searchBox = ov.querySelector(".msgr-att-search");
    const searchInp = searchBox.querySelector("input");
    const docsPaneEl = ov.querySelector('[data-pane="docs"]');
    const linksPaneEl = ov.querySelector('[data-pane="links"]');
    let curTab = "docs";
    function applySearch() {
      const q = searchInp.value.trim().toLowerCase();
      if (curTab === "docs") docsPaneEl.innerHTML = docsPane(q);
      else if (curTab === "links") linksPaneEl.innerHTML = linksPane(q);
    }
    searchInp.addEventListener("input", applySearch);
    ov.querySelectorAll(".msgr-att-tab").forEach((t) => t.addEventListener("click", () => {
      curTab = t.dataset.tab;
      ov.querySelectorAll(".msgr-att-tab").forEach((x) => x.classList.toggle("active", x === t));
      ov.querySelectorAll(".msgr-att-pane").forEach((p) => { p.hidden = p.dataset.pane !== curTab; });
      // Поиск доступен только для документов и ссылок.
      searchBox.hidden = curTab === "media";
      searchInp.value = "";
      applySearch();
      if (!searchBox.hidden) searchInp.focus();
    }));
    ov.querySelector('[data-pane="media"]').addEventListener("click", (e) => {
      const img = e.target.closest(".msgr-att-img");
      if (!img) return;
      e.preventDefault();
      const nodes = Array.prototype.slice.call(ov.querySelectorAll('[data-pane="media"] .msgr-att-img'));
      imageLightbox(nodes.map((a) => ({ url: a.getAttribute("href"), name: a.dataset.name })), nodes.indexOf(img));
    });
    // ПКМ по вложению → перейти к сообщению / копировать.
    ov.addEventListener("contextmenu", (e) => {
      const item = e.target.closest("[data-mid]");
      if (!item) return;
      e.preventDefault();
      const mid = item.dataset.mid;
      let copyVal = item.dataset.copy || item.getAttribute("href") || "";
      if (copyVal.indexOf("/") === 0) copyVal = location.origin + copyVal;   // абсолютный URL
      const items = [];
      if (mid && onGoToMessage) items.push({ label: "Перейти к сообщению", icon: "fa-arrow-right-to-bracket", onClick: () => { close(); onGoToMessage(parseInt(mid, 10)); } });
      items.push({ label: "Копировать", icon: "fa-copy", onClick: () => copyText(copyVal) });
      showContextMenu(e.clientX, e.clientY, items);
    });
    document.body.appendChild(ov);
  }

  // Модалка создания голосования.
  function pollModal(onCreate) {
    const ov = document.createElement("div");
    ov.className = "msgr-modal-ov";
    ov.innerHTML =
      '<div class="msgr-modal msgr-poll-modal">' +
        '<div class="msgr-modal-title">Новое голосование</div>' +
        '<input class="msgr-poll-inp" id="pmQ" maxlength="300" placeholder="Вопрос">' +
        '<textarea class="msgr-poll-inp" id="pmD" rows="2" maxlength="500" placeholder="Описание (необязательно)"></textarea>' +
        '<div class="msgr-poll-opts-edit" id="pmOpts"></div>' +
        '<button class="msgr-poll-add" id="pmAdd"><i class="fa-solid fa-plus"></i> Добавить вариант</button>' +
        '<div class="msgr-poll-settings">' +
          '<label><input type="checkbox" id="pmVoters"> Показывать, кто как проголосовал</label>' +
          '<label><input type="checkbox" id="pmMulti"> Несколько ответов</label>' +
          '<label><input type="checkbox" id="pmChange" checked> Разрешить менять ответ</label>' +
          '<label><input type="checkbox" id="pmBot" checked> Может участвовать ИИ-ассистент</label>' +
        "</div>" +
        '<div class="msgr-modal-actions">' +
          '<button class="msgr-modal-cancel">Отмена</button>' +
          '<button class="msgr-modal-ok msgr-poll-create">Создать</button>' +
        "</div>" +
      "</div>";
    const optsBox = ov.querySelector("#pmOpts");
    function addOpt(val) {
      if (optsBox.children.length >= 10) return;
      const row = document.createElement("div");
      row.className = "msgr-poll-opt-edit";
      row.innerHTML = '<input class="msgr-poll-inp" maxlength="300" placeholder="Вариант ' + (optsBox.children.length + 1) + '">' +
        '<button class="msgr-poll-rm" title="Убрать">&times;</button>';
      row.querySelector("input").value = val || "";
      row.querySelector(".msgr-poll-rm").addEventListener("click", () => { if (optsBox.children.length > 2) row.remove(); });
      optsBox.appendChild(row);
    }
    addOpt(); addOpt();
    ov.querySelector("#pmAdd").addEventListener("click", () => addOpt());
    const close = () => ov.remove();
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.querySelector(".msgr-modal-cancel").addEventListener("click", close);
    ov.querySelector(".msgr-poll-create").addEventListener("click", () => {
      const question = ov.querySelector("#pmQ").value.trim();
      const description = ov.querySelector("#pmD").value.trim();
      const options = [...optsBox.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
      if (!question) { ov.querySelector("#pmQ").focus(); return; }
      if (options.length < 2) { alert("Нужно минимум 2 варианта"); return; }
      close();
      onCreate({
        question, description, options,
        show_voters: ov.querySelector("#pmVoters").checked,
        allow_multiple: ov.querySelector("#pmMulti").checked,
        allow_change: ov.querySelector("#pmChange").checked,
        allow_bot: ov.querySelector("#pmBot").checked,
      });
    });
    document.body.appendChild(ov);
    ov.querySelector("#pmQ").focus();
  }

  // ─────────── стрим ответа ИИ (вопрос модели в диалоге) ───────────
  const AI_STATUS = {
    search: "Ищу в базе знаний…", rerank: "Подбираю релевантные фрагменты…",
    rerank_done: "Готовлю ответ…", generate: "Формулирую ответ…",
    intent: "Анализирую запрос…", extract_fields: "Разбираю данные…", plan: "Планирую поиск…",
  };
  function aiStatusLabel(s) { return AI_STATUS[s] || "Готовлю ответ…"; }
  function buildAiStreamNode(m, statusKey) {
    const div = document.createElement("div");
    div.dataset.id = m.id; div._msg = m;
    div.className = "message forwarded ai-streaming " + (m.mine ? "fwd-mine" : "fwd-peer");
    div.innerHTML =
      '<span class="msgr-select-check"><i class="fa-solid fa-check"></i></span>' +
      '<div class="message-avatar">🤖</div>' +
      '<div class="message-wrapper"><div class="message-content">' +
        '<div class="msgr-fwd-label"><i class="fa-solid fa-robot"></i> HR-ассистент</div>' +
        '<div class="bot-thinking" data-ai-thinking>' +
          '<div class="typing-indicator typing-inline"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>' +
          '<span class="bot-thinking-status">' + esc(aiStatusLabel(statusKey)) + "</span></div>" +
        '<div class="msgr-ai-live" data-ai-live></div>' +
      "</div></div>";
    return div;
  }
  function setAiStatus(node, key) { const s = node && node.querySelector(".bot-thinking-status"); if (s) s.textContent = aiStatusLabel(key); }
  function setAiText(node, text) {
    if (!node) return;
    const live = node.querySelector("[data-ai-live]"); if (live) live.textContent = text;
    const th = node.querySelector("[data-ai-thinking]"); if (th && text) th.style.display = "none";
  }

  // «был(а) только что / N минут назад / N часов назад / вчера / дата».
  function lastSeenText(iso) {
    if (!iso) return "не в сети";
    const d = new Date(iso), sec = Math.floor((Date.now() - d) / 1000);
    if (sec < 50) return "был(а) только что";
    const min = Math.floor(sec / 60);
    if (min < 60) return "был(а) " + min + " " + plural(min, "минуту", "минуты", "минут") + " назад";
    const hr = Math.floor(min / 60);
    if (hr < 24) return "был(а) " + hr + " " + plural(hr, "час", "часа", "часов") + " назад";
    const days = Math.floor(hr / 24);
    if (days === 1) return "был(а) вчера";
    if (days < 7) return "был(а) " + days + " " + plural(days, "день", "дня", "дней") + " назад";
    return "был(а) " + d.toLocaleDateString("ru-RU");
  }

  // Точка прокрутки к разделителю «Новые сообщения»: разделитель держим как можно
  // выше (максимум новых сообщений в кадре), но минимум 2 сообщения ДО линии
  // остаются видимыми — чтобы не терялся контекст разговора.
  function dividerScrollTop(dividerNode) {
    let anchor = dividerNode;
    let prev = dividerNode.previousElementSibling;
    let count = 0;
    while (prev && count < 2) {
      if (prev.classList && prev.classList.contains("message")) { anchor = prev; count++; }
      prev = prev.previousElementSibling;
    }
    return Math.max(0, anchor.offsetTop - 8);
  }

  return {
    esc, fmtTime, copyText, buildMessageNode, computeGroupFlags, groupFlag, messageText, groupedCopyText,
    imageLightbox, filePreview, showContextMenu, attachThreadInteractions, scrollToMessage,
    confirmDelete, editMessage, updatePinnedBar, pollModal, pollResultsModal, lastSeenText,
    buildAiStreamNode, setAiStatus, setAiText, pendingAttsHtml, attachmentsModal, attachLabel,
    typingLabel, buildTypingNode, dividerScrollTop,
  };
})();
