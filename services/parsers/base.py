from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ParsedDocument:
    text: str
    title: str = ""
    source_uri: str = ""
    source_type: str = "upload"  # local|web|upload
    mime_type: str | None = None
    pages: int = 0
    extra: dict[str, Any] = field(default_factory=dict)


# Сильные «имена» документов (само название) vs слабые ссылки (на утверждающий акт).
# «ПОЛОЖЕНИЕ» важнее, чем «Приказом № 5», которым оно утверждено.
_TITLE_STRONG = (
    "положени", "инструкци", "регламент", "правил", "порядок", "кодекс", "устав",
    "договор", "соглашени", "методическ", "стандарт", "политик", "руководств",
    "памятк", "перечень", "штатн",
)
_TITLE_STRONG_RE = re.compile(r"\b(" + "|".join(_TITLE_STRONG) + r")", re.IGNORECASE)
# Слабые — только если строка С НИХ начинается (именительный: «ПРИКАЗ № 5 …»),
# чтобы не цеплять ссылку «Приказом № 5» под «УТВЕРЖДЕНО».
_TITLE_WEAK_RE = re.compile(r"^(приказ|распоряжение)\b", re.IGNORECASE)
_TITLE_CONT_RE = re.compile(r"^(о|об|по|для|при)\b", re.IGNORECASE)
_TITLE_SKIP_RE = re.compile(r"^(утвержд|согласован|приложени|г\.|№|\d)", re.IGNORECASE)


def format_table(rows: list[list[str]]) -> list[str]:
    """Сериализует таблицу с СОХРАНЕНИЕМ связи строка↔столбец: первая строка —
    заголовки, каждая строка данных размечается метками колонок
    («Должность: Бухгалтер; Оклад: 60000»). Так значение не теряет смысл при
    чанковании и поиске. Возвращает список строк-абзацев."""
    cleaned: list[list[str]] = []
    for row in rows:
        cells = [(c or "").strip() for c in row]
        if any(cells):
            cleaned.append(cells)
    if not cleaned:
        return []

    ncols = max(len(r) for r in cleaned)
    for r in cleaned:
        r.extend([""] * (ncols - len(r)))

    # Нечего размечать — отдаём построчно через « | »
    if len(cleaned) < 2 or ncols < 2:
        return [" | ".join(c for c in r if c) for r in cleaned if any(r)]

    header = cleaned[0]
    out = ["Таблица — столбцы: " + " | ".join(h for h in header if h)]
    for r in cleaned[1:]:
        pairs = []
        for i, cell in enumerate(r):
            if not cell:
                continue
            label = header[i] if i < len(header) and header[i] else f"столбец {i + 1}"
            pairs.append(f"{label}: {cell}")
        if pairs:
            out.append("; ".join(pairs))
    return out


def _clean_title(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip().strip("«»\"'").strip()
    return s[:200]


def _with_continuation(lines: list[str], i: int) -> str:
    """Приклеивает продолжение названия со следующей строки («об оплате труда»)."""
    title = lines[i]
    if i + 1 < len(lines) and _TITLE_CONT_RE.match(lines[i + 1]) and len(title) < 120:
        title = f"{title} {lines[i + 1]}"
    return _clean_title(title)


def derive_title(text: str, fallback: str = "") -> str:
    """Извлекает человекочитаемое название из шапки документа
    («ПОЛОЖЕНИЕ об оплате труда», «Трудовой кодекс…»). Иначе — fallback (имя файла).
    Улучшает и цитирование, и разрешение doc_hint при множестве документов."""
    lines = [ln.strip() for ln in (text or "").split("\n")]
    lines = [ln for ln in lines if ln][:8]

    # 1) Сильное название документа
    for i, ln in enumerate(lines):
        if 8 <= len(ln) <= 200 and not _TITLE_SKIP_RE.match(ln) and _TITLE_STRONG_RE.search(ln):
            return _with_continuation(lines, i)

    # 2) Заголовок КАПСОМ в шапке
    for ln in lines:
        letters = [c for c in ln if c.isalpha()]
        if letters and 8 <= len(ln) <= 120 and len(ln.split()) >= 2:
            if sum(c.isupper() for c in letters) / len(letters) >= 0.8 and not _TITLE_SKIP_RE.match(ln):
                return _clean_title(ln)

    # 3) Слабое: документ-приказ (именительный в начале строки)
    for i, ln in enumerate(lines):
        if 8 <= len(ln) <= 200 and _TITLE_WEAK_RE.match(ln):
            return _with_continuation(lines, i)

    return fallback
