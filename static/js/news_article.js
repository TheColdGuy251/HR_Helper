/* Страница статьи новости: лайтбокс для картинок + удаление (для редакторов). */
(function () {
  "use strict";
  const article = document.querySelector(".news-article");
  if (!article) return;
  const body = document.getElementById("newsArticleBody");
  const lb = document.getElementById("newsLightbox");
  const lbImg = document.getElementById("newsLightboxImg");

  // Раскрытие картинок статьи в лайтбоксе.
  if (body && lb && lbImg) {
    body.querySelectorAll("img").forEach((img) => {
      img.classList.add("news-zoomable");
      img.addEventListener("click", () => {
        lbImg.src = img.currentSrc || img.src;
        lbImg.alt = img.alt || "";
        lb.hidden = false;
        document.body.style.overflow = "hidden";
      });
    });
    const close = () => { lb.hidden = true; lbImg.src = ""; document.body.style.overflow = ""; };
    lb.addEventListener("click", (e) => {
      if (e.target === lb || e.target.closest(".news-lightbox-close")) close();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !lb.hidden) close(); });
  }

  // ─────────────────────────── голосование ───────────────────────────
  const pollBox = document.getElementById("newsArticlePoll");
  const postId = article.dataset.id;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, a, b, c) => {
    n = Math.abs(n) % 100; const n1 = n % 10;
    if (n > 10 && n < 20) return c;
    if (n1 > 1 && n1 < 5) return b;
    if (n1 === 1) return a;
    return c;
  };

  function pollHtml(p) {
    const opts = p.options.map((o) => {
      const pct = p.total_votes ? Math.round((o.votes / p.total_votes) * 100) : 0;
      const voters = (p.show_voters && o.voters && o.voters.length)
        ? '<div class="msgr-poll-avatars">' + o.voters.slice(0, 8).map((v) =>
            '<span class="msgr-voter-ava" title="' + esc(v.name) + '">' + esc(v.initials || "?") + "</span>").join("") +
          (o.voters.length > 8 ? '<span class="msgr-voter-more">+' + (o.voters.length - 8) + "</span>" : "") + "</div>"
        : "";
      return '<button class="msgr-poll-opt' + (o.mine ? " mine" : "") + '" data-opt="' + o.id + '">' +
        '<div class="msgr-poll-opt-head"><span class="msgr-poll-check"><i class="fa-solid ' +
        (o.mine ? "fa-circle-check" : "fa-circle") + '"></i></span>' +
        '<span class="msgr-poll-opt-text">' + esc(o.text) + "</span>" +
        '<span class="msgr-poll-opt-cnt">' + o.votes + " · " + pct + "%</span></div>" +
        '<div class="msgr-poll-bar"><div class="msgr-poll-bar-fill" style="width:' + pct + '%"></div></div>' +
        voters + "</button>";
    }).join("");
    const sub = [p.total_votes + " " + plural(p.total_votes, "голос", "голоса", "голосов")];
    if (p.allow_multiple) sub.push("неск. ответов");
    if (p.show_voters) sub.push("открытое");
    return '<div class="msgr-poll" data-poll="' + p.id + '">' +
      '<div class="msgr-poll-q">' + esc(p.question) + "</div>" +
      (p.description ? '<div class="msgr-poll-desc">' + esc(p.description) + "</div>" : "") +
      '<div class="msgr-poll-card"><div class="msgr-poll-opts">' + opts + "</div></div>" +
      '<div class="msgr-poll-sub"><span>' + sub.join(" · ") + "</span></div></div>";
  }

  async function loadPoll() {
    if (!pollBox) return;
    try {
      const r = await fetch("/api/news/" + postId + "/poll");
      const d = await r.json();
      if (!d.poll) return;
      pollBox.hidden = false;
      pollBox.innerHTML = pollHtml(d.poll);
    } catch (e) {}
  }
  if (pollBox) {
    pollBox.addEventListener("click", async (e) => {
      const opt = e.target.closest(".msgr-poll-opt");
      if (!opt) return;
      try {
        const r = await fetch("/api/news/poll/vote", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ option_id: parseInt(opt.dataset.opt, 10) }),
        });
        const d = await r.json();
        if (d.poll) pollBox.innerHTML = pollHtml(d.poll);
      } catch (e) {}
    });
    loadPoll();
  }

  // Удаление статьи (редактор).
  const delBtn = document.getElementById("newsArticleDelete");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      if (!confirm("Удалить эту новость? Действие необратимо.")) return;
      try {
        const r = await fetch("/api/news/" + article.dataset.id, { method: "DELETE" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        location.href = "/news";
      } catch (e) { alert("Не удалось удалить: " + e.message); }
    });
  }
})();
