"""Конвертация старых форматов Office (.doc/.xls/.ppt/.rtf/.odt/.ods) в новые
через LibreOffice headless (`soffice --convert-to`). Готовое решение, не велосипед.

Если LibreOffice не установлен — бросаем понятную ошибку (документ попадёт в статус
failed с подсказкой), сервис не падает."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from config import settings
from utils.logger import logger

# Старый формат → целевой современный.
_TARGET_EXT = {
    ".doc": "docx",
    ".rtf": "docx",
    ".odt": "docx",
    ".xls": "xlsx",
    ".ods": "xlsx",
    ".ppt": "pptx",
    ".odp": "pptx",
}

_soffice_cache: str | None = None


def _find_soffice() -> str | None:
    global _soffice_cache
    if _soffice_cache:
        return _soffice_cache
    candidates: list[str] = []
    if settings.soffice_cmd:
        candidates.append(settings.soffice_cmd)
    if os.environ.get("SOFFICE_CMD"):
        candidates.append(os.environ["SOFFICE_CMD"])
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    candidates += [
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/usr/bin/soffice",
        "/usr/bin/libreoffice",
        "/opt/libreoffice/program/soffice",
    ]
    for c in candidates:
        try:
            if c and Path(c).exists():
                _soffice_cache = c
                return c
        except OSError:
            continue
    return None


def convert_to_modern(path: str | Path) -> Path:
    """Конвертирует старый формат в современный. Возвращает путь к новому файлу
    (во временной директории — вызывающий должен удалить её после парсинга).
    Бросает RuntimeError при отсутствии LibreOffice или ошибке конвертации."""
    path = Path(path)
    target = _TARGET_EXT.get(path.suffix.lower())
    if not target:
        raise RuntimeError(f"Формат {path.suffix} не поддерживается конвертером")

    soffice = _find_soffice()
    if not soffice:
        raise RuntimeError(
            "Не найден LibreOffice (soffice) для конвертации старого формата "
            f"{path.suffix}. Установите LibreOffice или укажите SOFFICE_CMD в .env."
        )

    outdir = Path(tempfile.mkdtemp(prefix="lo_conv_"))
    # Отдельный профиль на каждый вызов — снимает блокировку «soffice уже запущен»
    # при параллельных конвертациях.
    profile = (outdir / "profile").as_uri()
    cmd = [
        soffice,
        f"-env:UserInstallation={profile}",
        "--headless",
        "--norestore",
        "--convert-to",
        target,
        "--outdir",
        str(outdir),
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        shutil.rmtree(outdir, ignore_errors=True)
        raise RuntimeError("Конвертация LibreOffice превысила тайм-аут (180 с)")
    except Exception as e:
        shutil.rmtree(outdir, ignore_errors=True)
        raise RuntimeError(f"Ошибка запуска LibreOffice: {e}")

    out = outdir / f"{path.stem}.{target}"
    if not out.exists():
        # soffice иногда именует иначе — берём первый файл нужного типа
        files = list(outdir.glob(f"*.{target}"))
        out = files[0] if files else None
    if not out or not out.exists():
        err = (proc.stderr or b"").decode("utf-8", "ignore")[:300]
        shutil.rmtree(outdir, ignore_errors=True)
        raise RuntimeError(f"LibreOffice не создал выходной файл. {err}".strip())

    logger.info("LibreOffice: {} → {}", path.name, out.name)
    return out


def convert_to_pdf(path: str | Path) -> Path:
    """Конвертирует документ (pptx/ppt/odp/docx/…) в PDF через LibreOffice для
    предпросмотра в браузере. Возвращает путь к PDF во временной директории —
    вызывающий обязан удалить её (out.parent) после использования.
    Бросает RuntimeError при отсутствии LibreOffice или ошибке конвертации."""
    path = Path(path)
    soffice = _find_soffice()
    if not soffice:
        raise RuntimeError(
            "Не найден LibreOffice (soffice) для конвертации в PDF. "
            "Установите LibreOffice или укажите SOFFICE_CMD в .env."
        )

    outdir = Path(tempfile.mkdtemp(prefix="lo_pdf_"))
    profile = (outdir / "profile").as_uri()
    cmd = [
        soffice,
        f"-env:UserInstallation={profile}",
        "--headless",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        str(outdir),
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        shutil.rmtree(outdir, ignore_errors=True)
        raise RuntimeError("Конвертация LibreOffice в PDF превысила тайм-аут (180 с)")
    except Exception as e:
        shutil.rmtree(outdir, ignore_errors=True)
        raise RuntimeError(f"Ошибка запуска LibreOffice: {e}")

    out = outdir / f"{path.stem}.pdf"
    if not out.exists():
        files = list(outdir.glob("*.pdf"))
        out = files[0] if files else None
    if not out or not out.exists():
        err = (proc.stderr or b"").decode("utf-8", "ignore")[:300]
        shutil.rmtree(outdir, ignore_errors=True)
        raise RuntimeError(f"LibreOffice не создал PDF. {err}".strip())

    logger.info("LibreOffice → PDF: {} → {}", path.name, out.name)
    return out
