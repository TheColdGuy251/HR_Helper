/* Б1: «Характеристика на награду» — модалка на главной.
   Шаги: файл ходатайства → распознанные поля (правятся) → готовый .docx. */
(function () {
  "use strict";
  const openBtn = document.getElementById("chrOpenBtn");
  const overlay = document.getElementById("chrOverlay");
  if (!openBtn || !overlay) return;

  const $ = (id) => document.getElementById(id);
  const steps = { upload: $("chrStepUpload"), fields: $("chrStepFields"), result: $("chrStepResult") };
  const F = ["award", "basis", "fio", "position", "department", "degree", "rank"];

  function show(step) {
    Object.entries(steps).forEach(([k, el]) => { el.hidden = k !== step; });
  }
  function setStatus(el, text, kind) {
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "chr-status" + (kind ? " " + kind : "");
  }

  function open() { overlay.hidden = false; show("upload"); setStatus($("chrUploadStatus"), ""); }
  function close() { overlay.hidden = true; }
  openBtn.addEventListener("click", open);
  $("chrClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });

  /* ── Шаг 1: анализ ходатайства ── */
  $("chrFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("chrFileName").textContent = file.name;
    setStatus($("chrUploadStatus"), "Распознаю ходатайство… (извлечение полей ИИ)", "");
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch("/api/documents/characteristic/analyze", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) { setStatus($("chrUploadStatus"), "Ошибка: " + (d.detail || "?"), "error"); return; }
      fillFields(d.fields || {});
      show("fields");
      setStatus($("chrGenStatus"), "");
    } catch (err) {
      setStatus($("chrUploadStatus"), "Ошибка соединения: " + err.message, "error");
    } finally {
      e.target.value = "";
    }
  });

  function fillFields(f) {
    F.forEach((k) => { $("chrF_" + k).value = f[k] || ""; });
    $("chrF_category").value = f.category === "pps" ? "pps" : "aup";
    $("chrF_career").value = (f.career || []).join("\n");
    $("chrF_awards").value = (f.awards || []).join("\n");
    $("chrF_achievements").value = f.achievements || "";
  }

  $("chrBack").addEventListener("click", () => { show("upload"); });

  /* ── Шаг 2: генерация ── */
  $("chrGenerate").addEventListener("click", async () => {
    const fields = {};
    F.forEach((k) => { fields[k] = $("chrF_" + k).value.trim() || null; });
    fields.career = $("chrF_career").value;
    fields.awards = $("chrF_awards").value;
    fields.achievements = $("chrF_achievements").value.trim() || null;
    if (!fields.fio && !fields.achievements) {
      setStatus($("chrGenStatus"), "Заполните хотя бы ФИО или достижения", "error");
      return;
    }
    const btn = $("chrGenerate");
    btn.disabled = true;
    setStatus($("chrGenStatus"), "Формирую характеристику… (обычно 20–60 секунд)", "");
    try {
      const r = await fetch("/api/documents/characteristic/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: fields, category: $("chrF_category").value }),
      });
      const d = await r.json();
      if (!r.ok) { setStatus($("chrGenStatus"), "Ошибка: " + (d.detail || "?"), "error"); return; }
      $("chrResultTitle").textContent = d.title;
      $("chrPreview").textContent = d.text || "";
      $("chrView").href = d.view_url;
      $("chrDownload").href = d.download_url;
      show("result");
    } catch (err) {
      setStatus($("chrGenStatus"), "Ошибка соединения: " + err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  $("chrAgain").addEventListener("click", () => {
    $("chrFileName").textContent = "Выбрать файл ходатайства";
    show("upload");
    setStatus($("chrUploadStatus"), "");
  });
})();
