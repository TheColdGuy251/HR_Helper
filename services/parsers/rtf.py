from __future__ import annotations

from pathlib import Path

from services.parsers.base import ParsedDocument, derive_title


def parse_rtf(path: str | Path) -> ParsedDocument:
    """Нативный парсер .rtf (без LibreOffice) через striprtf. RTF хранит кириллицу
    как \\'xx-escape с указанием кодовой страницы (\\ansicpgXXXX) — striprtf сам её
    раскодирует; читаем файл в cp1251, чтобы ASCII-управляющие последовательности
    остались нетронутыми."""
    path = Path(path)
    from striprtf.striprtf import rtf_to_text

    raw = path.read_text(encoding="cp1251", errors="ignore")
    text = (rtf_to_text(raw) or "").strip()
    return ParsedDocument(
        text=text,
        title=derive_title(text, path.stem),
        source_uri=str(path),
        source_type="local",
        mime_type="application/rtf",
    )
