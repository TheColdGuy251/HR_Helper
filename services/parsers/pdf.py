from __future__ import annotations

from pathlib import Path

import fitz  # PyMuPDF

from config import settings
from services.parsers.base import ParsedDocument
from services.parsers.ocr import ocr_pdf_pages
from utils.logger import logger


def _digital_text_per_page(doc: "fitz.Document") -> list[str]:
    pages = []
    for page in doc:
        pages.append(page.get_text("text") or "")
    return pages


def parse_pdf(path: str | Path) -> ParsedDocument:
    path = Path(path)
    doc = fitz.open(path)
    try:
        digital_pages = _digital_text_per_page(doc)

        # Решаем по странице, нужен ли OCR
        ocr_targets: list[int] = []
        for idx, text in enumerate(digital_pages):
            if len(text.strip()) < settings.ocr_min_chars_per_page:
                ocr_targets.append(idx)

        if ocr_targets:
            logger.info("PDF {}: запускаю OCR для {} стр.", path.name, len(ocr_targets))
            try:
                ocr_text = ocr_pdf_pages(doc, ocr_targets)
                for idx, txt in ocr_text.items():
                    if txt and txt.strip():
                        digital_pages[idx] = txt
            except Exception as e:
                logger.warning("OCR не выполнен ({}): {}", path.name, e)

        full_text = "\n\n".join(p.strip() for p in digital_pages if p.strip())
        title = doc.metadata.get("title") or path.stem  # type: ignore[attr-defined]
        return ParsedDocument(
            text=full_text,
            title=title or path.stem,
            source_uri=str(path),
            source_type="local",
            mime_type="application/pdf",
            pages=len(digital_pages),
            # ocr_applied — был ли распознан хотя бы один скан-лист (для двойного
            # предпросмотра «оригинал + извлечённый текст» в /kb).
            extra={
                "author": (doc.metadata or {}).get("author"),  # type: ignore[attr-defined]
                "ocr_applied": bool(ocr_targets),
            },
        )
    finally:
        doc.close()
