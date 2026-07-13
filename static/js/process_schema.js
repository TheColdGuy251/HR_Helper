/* А10: «Единая схема процесса» — модалка на главной. Файл со схемой
   (Word/Excel/PowerPoint) → SVG в едином стиле ТИУ. Без LLM. */
(function () {
  "use strict";
  const openBtn = document.getElementById("prcOpenBtn");
  const overlay = document.getElementById("prcOverlay");
  if (!openBtn || !overlay) return;

  const $ = (id) => document.getElementById(id);
  let lastSvg = "";
  let lastTitle = "схема";

  function show(step) {
    $("prcStepUpload").hidden = step !== "upload";
    $("prcStepResult").hidden = step !== "result";
  }
  function setStatus(text, kind) {
    const el = $("prcStatus");
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "chr-status" + (kind ? " " + kind : "");
  }

  openBtn.addEventListener("click", () => { overlay.hidden = false; show("upload"); setStatus(""); });
  const close = () => { overlay.hidden = true; };
  $("prcClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });

  $("prcFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("prcFileName").textContent = file.name;
    setStatus("Распознаю блоки и стрелки, рисую схему…");
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch("/api/documents/process/render", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) { setStatus("Ошибка: " + (d.detail || "?"), "error"); return; }
      lastSvg = d.svg || "";
      lastTitle = d.title || file.name.replace(/\.[^.]+$/, "");
      $("prcResultTitle").textContent = d.title || "Схема процесса";
      $("prcStats").innerHTML = [
        ["Блоков", d.nodes], ["Переходов", d.edges], ["Ролей", d.roles],
      ].map(([k, v]) => '<span class="dpo-chip"><b>' + v + "</b> " + k + "</span>").join("");
      $("prcPreview").innerHTML = lastSvg;
      const dl = $("prcDownload");
      dl.href = URL.createObjectURL(new Blob([lastSvg], { type: "image/svg+xml" }));
      dl.download = lastTitle + ".svg";
      show("result");
    } catch (err) {
      setStatus("Ошибка соединения: " + err.message, "error");
    } finally {
      e.target.value = "";
    }
  });

  // Печать: отдельное окно только со схемой (масштабируется на страницу)
  $("prcPrint").addEventListener("click", () => {
    if (!lastSvg) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(
      "<!doctype html><title>" + lastTitle.replace(/</g, "&lt;") + "</title>" +
      '<style>body{margin:0;padding:16px}svg{max-width:100%;height:auto}</style>' + lastSvg
    );
    w.document.close();
    w.focus();
    w.print();
  });

  $("prcAgain").addEventListener("click", () => {
    $("prcFileName").textContent = "Выбрать файл со схемой";
    show("upload");
    setStatus("");
  });
})();
