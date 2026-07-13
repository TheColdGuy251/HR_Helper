"""Предпросмотр «слайдовых» форматов (pptx/ppt/odp) в браузере: конвертируем в PDF
через LibreOffice и кэшируем результат, чтобы не конвертировать при каждом открытии.

Кэш живёт в docs/.preview_cache, ключ — путь+размер+mtime исходника (изменился файл →
пересобираем PDF). Используется всеми страницами просмотра через параметр ?as=pdf у
эндпоинтов скачивания."""
from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from config import settings
from utils.logger import logger

# Форматы, для которых нет нативного браузерного просмотрщика — показываем как PDF.
SLIDE_EXTS = {".pptx", ".ppt", ".odp"}


def can_preview_as_pdf(path: str | Path) -> bool:
    return Path(path).suffix.lower() in SLIDE_EXTS


def _cache_dir() -> Path:
    d = Path(settings.docs_dir) / ".preview_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def preview_pdf_path(src: str | Path) -> Path | None:
    """Путь к PDF-версии презентации (с кэшированием). None — если формат не
    поддерживается, файла нет или LibreOffice недоступен/упал."""
    src = Path(src)
    if src.suffix.lower() not in SLIDE_EXTS or not src.exists() or not src.is_file():
        return None
    try:
        st = src.stat()
        key = f"{src.resolve()}|{st.st_size}|{int(st.st_mtime)}"
    except OSError:
        return None
    cached = _cache_dir() / (hashlib.sha1(key.encode("utf-8")).hexdigest() + ".pdf")
    if cached.exists():
        return cached

    try:
        from services.parsers.office_convert import convert_to_pdf

        tmp_pdf = convert_to_pdf(src)
    except Exception as e:
        logger.warning("Предпросмотр {} как PDF не удался: {}", src.name, e)
        return None
    try:
        shutil.copyfile(tmp_pdf, cached)
    except OSError as e:
        logger.warning("Не удалось сохранить PDF-превью в кэш: {}", e)
        return None
    finally:
        shutil.rmtree(tmp_pdf.parent, ignore_errors=True)
    return cached


def preview_pdf_response(src: str | Path):
    """FileResponse с PDF-превью (inline) или None, если превью недоступно."""
    from fastapi.responses import FileResponse

    pdf = preview_pdf_path(src)
    if not pdf:
        return None
    return FileResponse(
        pdf,
        filename=Path(src).stem + ".pdf",
        media_type="application/pdf",
        content_disposition_type="inline",
    )
