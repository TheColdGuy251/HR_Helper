/* Б6 «Вакансия из инструкции» + Б7 «Дубликаты инструкций ОТ» — модалки на главной. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s));

  function wireModal(prefix) {
    const openBtn = $(prefix + "OpenBtn");
    const overlay = $(prefix + "Overlay");
    if (!openBtn || !overlay) return null;
    const show = (step) => {
      $(prefix + "StepUpload").hidden = step !== "upload";
      $(prefix + "StepResult").hidden = step !== "result";
    };
    const setStatus = (text, kind) => {
      const el = $(prefix + "Status");
      el.hidden = !text;
      el.textContent = text || "";
      el.className = "chr-status" + (kind ? " " + kind : "");
    };
    openBtn.addEventListener("click", () => { overlay.hidden = false; show("upload"); setStatus(""); });
    const close = () => { overlay.hidden = true; };
    $(prefix + "Close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });
    return { show, setStatus };
  }

  /* ===== Б6: вакансия ===== */
  const vac = wireModal("vac");
  if (vac) {
    $("vacFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $("vacFileName").textContent = file.name;
      vac.setStatus("Читаю инструкцию и пишу текст вакансии… (обычно до минуты)");
      const fd = new FormData();
      fd.append("file", file);
      try {
        const r = await fetch("/api/documents/vacancy/generate", { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) { vac.setStatus("Ошибка: " + (d.detail || "?"), "error"); return; }
        $("vacResultTitle").textContent = d.title +
          (d.section_found ? "" : " (раздел 2 не найден — использован весь текст)");
        $("vacPreview").textContent = d.text || "";
        $("vacView").href = d.view_url;
        $("vacDownload").href = d.download_url;
        vac.show("result");
      } catch (err) {
        vac.setStatus("Ошибка соединения: " + err.message, "error");
      } finally {
        e.target.value = "";
      }
    });
    $("vacAgain").addEventListener("click", () => {
      $("vacFileName").textContent = "Выбрать должностную инструкцию";
      vac.show("upload");
      vac.setStatus("");
    });
  }

  /* ===== Б7: дубликаты инструкций ОТ ===== */
  const otd = wireModal("otd");
  if (otd) {
    $("otdFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $("otdFileName").textContent = file.name;
      otd.setStatus("Разбираю архив и сравниваю тексты… (сотни файлов — несколько минут)");
      const fd = new FormData();
      fd.append("file", file);
      try {
        const r = await fetch("/api/documents/ot/dedup", { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) { otd.setStatus("Ошибка: " + (d.detail || "?"), "error"); return; }
        $("otdResultTitle").textContent =
          `Проверено файлов: ${d.files}, пар-дубликатов (≥80%): ${d.duplicates}`;
        $("otdStats").innerHTML = [
          ["файлов", d.files],
          ["пар ≥80%", d.duplicates],
          ["пар 60–80%", (d.pairs || []).length - d.duplicates],
          ["групп однотипных", (d.groups || []).length],
        ].map(([k, v]) => `<span class="dpo-chip"><b>${v}</b> ${k}</span>`).join("");

        let html = "";
        if ((d.groups || []).length) {
          html += "<h4>Группы однотипных (кандидаты на объединение)</h4>" +
            d.groups.map((g) =>
              `<div class="otd-group"><b>${g.size} файлов</b> · совпадение ${g.min_percent === g.max_percent
                ? g.max_percent : g.min_percent + "–" + g.max_percent}%<br>` +
              g.files.map(esc).join("<br>") + "</div>").join("");
        }
        if ((d.pairs || []).length) {
          html += "<h4>Пары (топ-30)</h4><table class='otd-table'><tr><th>Инструкция 1</th><th>Инструкция 2</th><th>%</th></tr>" +
            d.pairs.slice(0, 30).map((p) =>
              `<tr class="${p.percent >= 80 ? "otd-dup" : ""}"><td>${esc(p.a)}</td><td>${esc(p.b)}</td><td>${p.percent}</td></tr>`
            ).join("") + "</table>";
        }
        if (!html) html = "<p>Совпадений выше 60% не найдено — дубликатов нет.</p>";
        if ((d.unreadable || []).length) {
          html += `<p class="otd-warn">Не удалось прочитать: ${d.unreadable.map(esc).join(", ")}</p>`;
        }
        $("otdTables").innerHTML = html;
        $("otdDownload").href = d.download_url;
        otd.show("result");
      } catch (err) {
        otd.setStatus("Ошибка соединения: " + err.message, "error");
      } finally {
        e.target.value = "";
      }
    });
    $("otdAgain").addEventListener("click", () => {
      $("otdFileName").textContent = "Выбрать ZIP-архив";
      otd.show("upload");
      otd.setStatus("");
    });
  }

  /* ===== Б3: справка на работника ===== */
  const crt = wireModal("crt");
  if (crt) {
    $("crtFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $("crtFileName").textContent = file.name;
      crt.setStatus("Преобразую выгрузку в читабельную справку…");
      const fd = new FormData();
      fd.append("file", file);
      try {
        const r = await fetch("/api/documents/certificate/convert", { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) { crt.setStatus("Ошибка: " + (d.detail || "?"), "error"); return; }
        $("crtResultTitle").textContent = d.title;
        $("crtSummary").textContent = d.summary || "";
        $("crtView").href = d.view_url;
        $("crtDownload").href = d.download_url;
        crt.show("result");
      } catch (err) {
        crt.setStatus("Ошибка соединения: " + err.message, "error");
      } finally {
        e.target.value = "";
      }
    });
    $("crtAgain").addEventListener("click", () => {
      $("crtFileName").textContent = "Выбрать выгрузку (.xls)";
      crt.show("upload");
      crt.setStatus("");
    });
  }

  /* ===== Б4: опись уволенных ===== */
  const inv = wireModal("inv");
  if (inv) {
    $("invFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $("invFileName").textContent = file.name;
      inv.setStatus("Ищу уволенных без повторного приёма…");
      const fd = new FormData();
      fd.append("file", file);
      fd.append("all_categories", $("invAllCats").checked ? "true" : "false");
      try {
        const r = await fetch("/api/documents/inventory/build", { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) { inv.setStatus("Ошибка: " + (d.detail || "?"), "error"); return; }
        $("invResultTitle").textContent = d.title;
        $("invStats").innerHTML = [
          ["в описи", d.count],
          ["уволено всего", d.fired_total],
          ["повторно приняты (исключены)", d.skipped_rehired],
          ["год", d.year],
        ].map(([k, v]) => `<span class="dpo-chip"><b>${v}</b> ${k}</span>`).join("");
        $("invTable").innerHTML = (d.items || []).length
          ? "<table class='otd-table'><tr><th>№</th><th>Ф.И.О.</th><th>Должность</th><th>Подразделение</th><th>Дата увольнения</th></tr>" +
            d.items.slice(0, 50).map((it) =>
              `<tr><td>${it.n}</td><td>${esc(it.fio)}</td><td>${esc(it.position)}</td><td>${esc(it.unit)}</td><td>${esc(it.dismissed_at)}</td></tr>`
            ).join("") + "</table>"
          : "<p>Под условия описи никто не попал.</p>";
        $("invDownload").href = d.download_url;
        inv.show("result");
      } catch (err) {
        inv.setStatus("Ошибка соединения: " + err.message, "error");
      } finally {
        e.target.value = "";
      }
    });
    $("invAgain").addEventListener("click", () => {
      $("invFileName").textContent = "Выбрать отчёт (.xls)";
      inv.show("upload");
      inv.setStatus("");
    });
  }

  /* ===== Б5: объявление конкурса ППС ===== */
  const pps = wireModal("pps");
  if (pps) {
    $("ppsFile").addEventListener("change", async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      $("ppsFileName").textContent = files.length === 1 ? files[0].name : files.length + " файлов";
      pps.setStatus("Собираю объявление по должностям и кафедрам…");
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      try {
        const r = await fetch("/api/documents/pps/announcement", { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) { pps.setStatus("Ошибка: " + (d.detail || "?"), "error"); return; }
        $("ppsResultTitle").textContent = d.title;
        $("ppsStats").innerHTML = [
          ["должностей", d.positions],
          ["кафедр", d.departments],
          ["работников в выгрузках", d.people],
        ].map(([k, v]) => `<span class="dpo-chip"><b>${v}</b> ${k}</span>`).join("") +
          "<br>" + (d.sections || []).map((s) => `<span class="dpo-chip">${esc(s.header)} — ${s.count}</span>`).join("");
        $("ppsView").href = d.view_url;
        $("ppsDownload").href = d.download_url;
        pps.show("result");
      } catch (err) {
        pps.setStatus("Ошибка соединения: " + err.message, "error");
      } finally {
        e.target.value = "";
      }
    });
    $("ppsAgain").addEventListener("click", () => {
      $("ppsFileName").textContent = "Выбрать файлы «Форма 2»";
      pps.show("upload");
      pps.setStatus("");
    });
  }
})();
