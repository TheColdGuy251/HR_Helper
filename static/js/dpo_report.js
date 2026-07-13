/* Б2: «Отчёт по ДПО» — модалка на главной. Один шаг: xlsx → готовый отчёт
   (все числа детерминированные, LLM не участвует). */
(function () {
  "use strict";
  const openBtn = document.getElementById("dpoOpenBtn");
  const overlay = document.getElementById("dpoOverlay");
  if (!openBtn || !overlay) return;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s));

  function show(step) {
    $("dpoStepUpload").hidden = step !== "upload";
    $("dpoStepResult").hidden = step !== "result";
  }
  function setStatus(text, kind) {
    const el = $("dpoStatus");
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "chr-status" + (kind ? " " + kind : "");
  }

  openBtn.addEventListener("click", () => { overlay.hidden = false; show("upload"); setStatus(""); });
  const close = () => { overlay.hidden = true; };
  $("dpoClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });

  $("dpoFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("dpoFileName").textContent = file.name;
    setStatus("Считаю агрегаты и формирую отчёт… (крупная выгрузка — до минуты)");
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch("/api/documents/dpo/report", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) { setStatus("Ошибка: " + (d.detail || "?"), "error"); return; }
      $("dpoResultTitle").textContent = d.title;
      const s = d.stats || {};
      $("dpoStats").innerHTML = [
        ["Работников", s.total_people],
        ["Программ", s.total_programs],
        ["Мероприятий ≥16 ч", s.long_events],
        ["Краткосрочных <16 ч", s.short_events],
        ["Всего записей", s.total_records],
      ].map(([k, v]) => '<span class="dpo-chip"><b>' + esc(v) + "</b> " + esc(k) + "</span>").join("");
      $("dpoPreview").textContent = d.text || "";
      $("dpoView").href = d.view_url;
      $("dpoDownload").href = d.download_url;
      show("result");
    } catch (err) {
      setStatus("Ошибка соединения: " + err.message, "error");
    } finally {
      e.target.value = "";
    }
  });

  $("dpoAgain").addEventListener("click", () => {
    $("dpoFileName").textContent = "Выбрать xlsx-выгрузку";
    show("upload");
    setStatus("");
  });
})();
