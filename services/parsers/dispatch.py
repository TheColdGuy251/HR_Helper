from __future__ import annotations

from pathlib import Path

from services.parsers.base import ParsedDocument
from services.parsers.pdf import parse_pdf
from services.parsers.docx import parse_docx
from services.parsers.plain import parse_text_file
from services.parsers.pptx import parse_pptx
from services.parsers.rtf import parse_rtf
from services.parsers.xls import parse_xls
from services.parsers.xlsx import parse_xlsx
from services.parsers.web import parse_url
from utils.logger import logger


def parse_file(path: str | Path) -> ParsedDocument:
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return parse_pdf(path)
    if suffix == ".docx":
        return parse_docx(path)
    if suffix in (".xlsx", ".xlsm"):
        return parse_xlsx(path)
    if suffix == ".pptx":
        return parse_pptx(path)
    if suffix in (".txt", ".md", ".rst", ".csv"):
        return parse_text_file(path)
    if suffix in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"):
        return _parse_image(path)
    # .rtf и .xls читаем НАТИВНО (без LibreOffice); при неудаче — откат на конвертацию.
    if suffix == ".rtf":
        return _try_native(parse_rtf, path)
    if suffix == ".xls":
        return _try_native(parse_xls, path)
    # Прочие старые форматы (.doc/.odt/.ods/.ppt/.odp) → LibreOffice (#9).
    if suffix in (".doc", ".odt", ".ods", ".ppt", ".odp"):
        return _parse_legacy_office(path)
    raise ValueError(f"Неподдерживаемый формат: {suffix}")


def _try_native(parser, path: Path) -> ParsedDocument:
    """Пробуем чистый Python-парсер; если он упал или дал пустой текст —
    откатываемся на конвертацию через LibreOffice (когда он доступен)."""
    try:
        parsed = parser(path)
        if (parsed.text or "").strip():
            return parsed
        logger.info("{}: нативный парсер дал пустой текст — пробую LibreOffice", path.name)
    except Exception as e:
        logger.info("{}: нативный парсер не смог ({}) — пробую LibreOffice", path.name, e)
    return _parse_legacy_office(path)


def _parse_legacy_office(path: Path) -> ParsedDocument:
    """Конвертирует старый формат в docx/xlsx (LibreOffice) и парсит результат.
    Метаданные (source_uri, title) сохраняем по ОРИГИНАЛЬНОМУ файлу."""
    import shutil

    from services.parsers.office_convert import convert_to_modern

    conv = convert_to_modern(path)
    try:
        conv_suffix = conv.suffix.lower()
        if conv_suffix == ".docx":
            parsed = parse_docx(conv)
        elif conv_suffix == ".pptx":
            parsed = parse_pptx(conv)
        else:
            parsed = parse_xlsx(conv)
    finally:
        shutil.rmtree(conv.parent, ignore_errors=True)

    parsed.source_uri = str(path)
    parsed.title = parsed.title or path.stem
    parsed.mime_type = None
    return parsed


def _parse_image(path: Path) -> ParsedDocument:
    """Изображение → текст через OCR (содержимое фото документа/скана)."""
    from services.parsers.ocr import ocr_image_bytes

    data = path.read_bytes()
    try:
        text = ocr_image_bytes(data) or ""
    except Exception:
        text = ""
    return ParsedDocument(
        text=text.strip(),
        title=path.stem,
        source_uri=str(path),
        source_type="upload",
        mime_type="image/" + (path.suffix.lower().lstrip(".") or "png"),
        extra={"ocr_applied": True},  # изображение всегда распознаётся через OCR
    )


__all__ = ["parse_file", "parse_url", "ParsedDocument"]
