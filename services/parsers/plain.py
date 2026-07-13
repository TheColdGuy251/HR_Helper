from __future__ import annotations

from pathlib import Path

from services.parsers.base import ParsedDocument


def parse_text_file(path: str | Path) -> ParsedDocument:
    path = Path(path)
    text = path.read_text(encoding="utf-8", errors="ignore")
    return ParsedDocument(
        text=text,
        title=path.stem,
        source_uri=str(path),
        source_type="local",
        mime_type="text/plain",
    )
