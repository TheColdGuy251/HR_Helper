"""Извлечение ссылок «см. ст. 81», «согласно главе 12», «в соответствии с п. 5»
из текста чанка и сохранение их в таблицу kb_links для последующей подтяжки
связанных норм при ответе."""
from __future__ import annotations

import re
from dataclasses import dataclass

# Захватываем номер сразу после маркера. Поддерживаем точечные номера: 84.1, 12.3.5.
_LINK_PATTERNS = [
    (re.compile(r"\bстат(?:ья|ьи|ью)\s+(\d+(?:\.\d+)*)", re.IGNORECASE), "article"),
    (re.compile(r"\bст\.?\s*(\d+(?:\.\d+)*)", re.IGNORECASE), "article"),
    (re.compile(r"\bглав(?:а|ы|у|е)\s+(\d+)", re.IGNORECASE), "chapter"),
    (re.compile(r"\bгл\.?\s*(\d+)", re.IGNORECASE), "chapter"),
    (re.compile(r"\bпункт(?:а|у|е|ом)?\s+(\d+(?:\.\d+)*)", re.IGNORECASE), "clause"),
    (re.compile(r"\bп\.?\s*(\d+(?:\.\d+)*)", re.IGNORECASE), "clause"),
    (re.compile(r"\bраздел[а-я]*\s+(\d+)", re.IGNORECASE), "section"),
]

# Подсказка про целевой документ: «ст. 81 ТК», «ст. 12 ГК»
_DOC_HINT_RE = re.compile(
    r"\b(?:стат(?:ья|ьи|ью)|ст\.?|глав[ауыие]|пункт(?:а|у|е|ом)?|п\.?)\s*"
    r"\d+(?:\.\d+)*\s+(?P<hint>[А-Я]{2,5}(?:\s+РФ)?)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ParsedLink:
    kind: str        # article | chapter | clause | section
    number: str      # "81", "84.1", "12.3.5"
    doc_hint: str | None  # "ТК", "ТК РФ", "ГК" или None
    chunk_index: int | None


def extract_links(text: str, chunk_index: int | None = None) -> list[ParsedLink]:
    """Возвращает уникальные ссылки в порядке появления."""
    if not text:
        return []
    found: list[ParsedLink] = []
    seen: set[tuple[str, str, str | None]] = set()
    for pat, kind in _LINK_PATTERNS:
        for m in pat.finditer(text):
            number = m.group(1).rstrip(".")
            # Локальная подсказка на документ — ищем в окрестности 40 символов
            window = text[max(0, m.start() - 5) : min(len(text), m.end() + 40)]
            hint_match = _DOC_HINT_RE.search(window)
            hint = hint_match.group("hint").upper() if hint_match else None
            key = (kind, number, hint)
            if key in seen:
                continue
            seen.add(key)
            found.append(
                ParsedLink(
                    kind=kind,
                    number=number,
                    doc_hint=hint,
                    chunk_index=chunk_index,
                )
            )
    return found
