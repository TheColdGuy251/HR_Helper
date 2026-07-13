from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from data.db_session import get_db
from data.doc_templates import DocTemplate
from data.my_documents import MyDocuments
from data.users import User
from forms.chat import GenerateDocRequest
from services.documents import generate_document, list_templates
from services.documents.generator import extract_fields_with_llm
from utils.auth_deps import require_user

router = APIRouter(prefix="/api/documents", tags=["documents"])


@router.get("/templates")
async def get_templates(user: User = Depends(require_user), db: Session = Depends(get_db)):
    items = list_templates(db)
    return {
        "success": True,
        "items": [
            {
                "key": t.key,
                "title": t.title,
                "description": t.description,
                "fields": t.fields_schema or [],
            }
            for t in items
        ],
    }


@router.post("/generate")
async def generate(
    body: GenerateDocRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    try:
        doc = generate_document(db, user, body.template_key, body.fields, title=body.title)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Не удалось сгенерировать документ: {e}")
    return {"success": True, "document_id": doc.id, "file_path": doc.file_path}


@router.post("/extract-fields")
async def extract_fields(
    body: dict,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    template_key = body.get("template_key")
    text = body.get("text", "")
    tpl = db.query(DocTemplate).filter(DocTemplate.key == template_key).first()
    if not tpl:
        raise HTTPException(404, "Шаблон не найден")
    fields = extract_fields_with_llm(tpl, text)
    return {"success": True, "fields": fields}


# ---------------------------------------------------------------------------
# Б1: характеристика для внешней награды из ходатайства (1С:Документооборот)
# ---------------------------------------------------------------------------

_PETITION_EXT = {".docx", ".doc", ".rtf", ".pdf", ".txt", ".odt"}


@router.post("/characteristic/analyze")
async def characteristic_analyze(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
):
    """Шаг 1: парсинг ходатайства (эфемерно — файл НЕ сохраняется и НЕ попадает
    в базу знаний, там персональные данные) и извлечение полей для проверки."""
    import os
    import tempfile
    from pathlib import Path

    from services.documents.characteristic import parse_petition
    from services.parsers import parse_file

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _PETITION_EXT:
        raise HTTPException(400, f"Неподдерживаемый формат ходатайства: {suffix or '?'}")

    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(400, "Файл больше 15 МБ")
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as fp:
            fp.write(data)
        try:
            parsed = parse_file(tmp)
        except Exception as e:
            raise HTTPException(400, f"Не удалось распарсить файл: {e}")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    text = (parsed.text or "").strip()
    if not text:
        raise HTTPException(400, "Не удалось извлечь текст из ходатайства")
    fields = parse_petition(text)
    return {"success": True, "fields": fields}


@router.post("/characteristic/generate")
async def characteristic_generate(
    body: dict,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Шаг 2: генерация характеристики по (возможно поправленным) полям."""
    from services.documents.characteristic import create_characteristic, petition_fields_from_json

    fields = petition_fields_from_json(body.get("fields") or {})
    if not fields.get("fio") and not fields.get("achievements"):
        raise HTTPException(400, "Нужны хотя бы ФИО или текст достижений из ходатайства")
    try:
        doc, text = create_characteristic(db, user, fields, body.get("category"))
    except Exception as e:
        raise HTTPException(500, f"Не удалось сформировать характеристику: {e}")
    return {
        "success": True,
        "document_id": doc.id,
        "title": doc.title,
        "view_url": f"/documents/{doc.id}/view",
        "download_url": f"/api/documents/{doc.id}/download",
        "text": text,
    }


# ---------------------------------------------------------------------------
# Б2: отчёт по ДПО из xlsx-выгрузки 1С:ЗиК («ПК за период»)
# ---------------------------------------------------------------------------


@router.post("/dpo/report")
async def dpo_report(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Один шаг: xlsx → детерминированные агрегаты → word-отчёт по образцу
    «ДПО за год». LLM не используется — все числа считаются из таблицы."""
    import os
    import tempfile
    from pathlib import Path

    from services.documents.dpo_report import create_dpo_report

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in (".xlsx", ".xlsm"):
        raise HTTPException(400, "Ожидается xlsx-выгрузка «ПК за период» из 1С:ЗиК")
    data = await file.read()
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(400, "Файл больше 30 МБ")

    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as fp:
            fp.write(data)
        try:
            doc, text, stats = create_dpo_report(db, user, tmp)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(500, f"Не удалось сформировать отчёт: {e}")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    return {
        "success": True,
        "document_id": doc.id,
        "title": doc.title,
        "view_url": f"/documents/{doc.id}/view",
        "download_url": f"/api/documents/{doc.id}/download",
        "text": text,
        "stats": {
            "year": stats["year"],
            "total_people": stats["total_people"],
            "total_programs": stats["total_programs"],
            "total_records": stats["total_records"],
            "long_events": stats["long_events"],
            "short_events": stats["short_events"],
        },
    }


@router.get("/{document_id}/download")
async def download(
    document_id: int,
    inline: bool = Query(default=False),
    as_: str | None = Query(default=None, alias="as"),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    # Документы общие для всех сотрудников (внутренний инструмент) — без проверки владельца.
    doc = db.get(MyDocuments, document_id)
    if not doc:
        raise HTTPException(404, "Документ не найден")
    if not doc.file_path or not Path(doc.file_path).exists():
        raise HTTPException(404, "Файл документа отсутствует")
    if as_ == "pdf":
        from utils.file_preview import preview_pdf_response

        resp = preview_pdf_response(doc.file_path)
        if resp is not None:
            return resp
    media = {
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".pdf": "application/pdf",
        ".svg": "image/svg+xml",
    }.get(Path(doc.file_path).suffix.lower(), "application/octet-stream")
    return FileResponse(
        doc.file_path,
        filename=Path(doc.file_path).name,
        media_type=media,
        content_disposition_type="inline" if inline else "attachment",
    )


@router.delete("/{document_id}")
async def delete_my_document(
    document_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    from config import settings

    # Общий доступ: любой сотрудник может удалить документ (по #2).
    doc = db.get(MyDocuments, document_id)
    if not doc:
        raise HTTPException(404, "Документ не найден")

    # Удаляем файл, если он внутри docs/ (path-traversal-safe)
    if doc.file_path:
        try:
            path = Path(doc.file_path).resolve()
            path.relative_to(settings.docs_dir.resolve())
            path.unlink(missing_ok=True)
        except (ValueError, OSError):
            pass

    db.delete(doc)
    db.commit()
    return {"success": True}


@router.get("")
async def list_my_documents(user: User = Depends(require_user), db: Session = Depends(get_db)):
    docs = (
        db.query(MyDocuments)
        .filter(MyDocuments.user_id == user.id)
        .order_by(MyDocuments.last_activity.desc())
        .all()
    )
    return {
        "success": True,
        "items": [
            {
                "id": d.id,
                "title": d.title,
                "template_key": d.template_key,
                "status": d.status,
                "progress": d.progress,
                "last_activity": d.last_activity.isoformat(),
            }
            for d in docs
        ],
    }


# ---------------------------------------------------------------------------
# А10: приведение схем процессов к единому виду (docx/pptx/xlsx → SVG)
# ---------------------------------------------------------------------------

_PROCESS_EXT = {".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xlsm", ".xls"}


@router.post("/process/render")
async def process_render(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
):
    """Файл со схемой процесса (фигуры + стрелки из Word/Excel/PowerPoint) →
    единый SVG в стиле ТИУ. Детерминированно, без LLM; файл не сохраняется."""
    import os
    import re as _re
    import tempfile

    from services.processes import extract_process_graph, render_process_svg

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _PROCESS_EXT:
        raise HTTPException(400, f"Неподдерживаемый формат схемы: {suffix or '?'}")
    data = await file.read()
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(400, "Файл больше 30 МБ")

    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as fp:
            fp.write(data)
        graph = extract_process_graph(tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    if graph is None:
        raise HTTPException(
            422,
            "Не удалось распознать схему: в файле нет блоков со стрелками "
            "(если схема — картинка/скан, векторно преобразовать её нельзя)",
        )
    if not graph.title:
        # «!процесс вакансии ИИ.docx» → «Процесс вакансии»
        stem = Path(file.filename or "схема").stem
        stem = _re.sub(r"\s*ИИ\s*$", "", stem.lstrip("!_ ")).strip()
        graph.title = stem[:1].upper() + stem[1:] if stem else None
    svg = render_process_svg(graph)
    return {
        "success": True,
        "title": graph.title,
        "svg": svg,
        "nodes": len(graph.nodes),
        "edges": len(graph.edges),
        "roles": sum(1 for n in graph.nodes if n.role),
    }


# ---------------------------------------------------------------------------
# Б7: дубликаты инструкций по охране труда (пары с совпадением текста ≥60/80%)
# ---------------------------------------------------------------------------

_OT_EXT = {".docx", ".doc", ".pdf", ".rtf", ".txt", ".odt"}
_OT_MAX_FILES = 500


@router.post("/ot/dedup")
def ot_dedup(  # sync def → выполняется в thread-пуле, не блокирует event loop
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """ZIP с инструкциями по ОТ → пары с процентом совпадения текста + группы
    однотипных (кандидаты на объединение) + xlsx-отчёт. Детерминированно, без LLM."""
    import os
    import tempfile

    from services.documents.ot_dedup import run_dedup_zip

    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "Ожидается ZIP-архив с инструкциями (docx/doc/pdf/rtf/txt)")
    data = file.file.read()
    if len(data) > 300 * 1024 * 1024:
        raise HTTPException(400, "Архив больше 300 МБ")

    fd, tmp = tempfile.mkstemp(suffix=".zip")
    try:
        with os.fdopen(fd, "wb") as fp:
            fp.write(data)
        try:
            rec, result = run_dedup_zip(db, user, tmp)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(400, f"Не удалось обработать архив: {e}")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    return {
        "success": True,
        "document_id": rec.id,
        "download_url": f"/api/documents/{rec.id}/download",
        "files": result["files"],
        "duplicates": result["duplicates"],
        "unreadable": result.get("unreadable", [])[:20],
        "pairs": result["pairs"][:200],
        "groups": result["groups"][:50],
    }


# ---------------------------------------------------------------------------
# Б6: вакансия для job-сайтов из должностной инструкции (раздел 2)
# ---------------------------------------------------------------------------

_DI_EXT = {".docx", ".doc", ".pdf", ".rtf", ".txt", ".odt"}


@router.post("/vacancy/generate")
async def vacancy_generate(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Должностная инструкция → текст вакансии (LLM переписывает раздел 2
    «Должностные обязанности» в форму для hh.ru). Файл не сохраняется в БЗ."""
    import os
    import tempfile

    from services.documents.vacancy import create_vacancy
    from services.parsers import parse_file

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _DI_EXT:
        raise HTTPException(400, f"Неподдерживаемый формат инструкции: {suffix or '?'}")
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(400, "Файл больше 15 МБ")

    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as fp:
            fp.write(data)
        try:
            parsed = parse_file(tmp)
        except Exception as e:
            raise HTTPException(400, f"Не удалось распарсить файл: {e}")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    try:
        doc, text, meta = create_vacancy(db, user, parsed.text)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Не удалось сформировать вакансию: {e}")
    return {
        "success": True,
        "document_id": doc.id,
        "title": doc.title,
        "view_url": f"/documents/{doc.id}/view",
        "download_url": f"/api/documents/{doc.id}/download",
        "text": text,
        "position": meta.get("position"),
        "section_found": meta.get("section_found"),
    }


# ---------------------------------------------------------------------------
# Б3–Б5: табличные преобразователи выгрузок 1С:ЗиК (детерминированно, без LLM)
# ---------------------------------------------------------------------------

_XL_EXT = {".xls", ".xlsx", ".xlsm"}


async def _save_upload_tmp(file: UploadFile, allowed: set[str], max_mb: int = 30) -> str:
    """Сохраняет загрузку во временный файл, возвращает путь (unlink — на вызывающем)."""
    import os
    import tempfile

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in allowed:
        raise HTTPException(400, f"Неподдерживаемый формат: {suffix or '?'} (нужен {'/'.join(sorted(allowed))})")
    data = await file.read()
    if len(data) > max_mb * 1024 * 1024:
        raise HTTPException(400, f"Файл больше {max_mb} МБ")
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as fp:
        fp.write(data)
    return tmp


def _unlink_quiet(*paths: str) -> None:
    import os

    for p in paths:
        try:
            os.unlink(p)
        except OSError:
            pass


@router.post("/certificate/convert")
async def certificate_convert(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Б3: выгрузка «Справка на сотрудника» из 1С:ЗиК → читабельный docx
    (ПК за 3 года, работа — по должностям без дублей приказов)."""
    from services.documents.employee_certificate import create_certificate

    tmp = await _save_upload_tmp(file, _XL_EXT)
    try:
        try:
            doc, fields = create_certificate(db, user, tmp)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(500, f"Не удалось сформировать справку: {e}")
    finally:
        _unlink_quiet(tmp)
    preview = []
    for name in ("Повышение квалификации", "Работа по окончании ВУЗа"):
        val = fields.get(name)
        if isinstance(val, list):
            preview.append(f"{name}: {len(val)} записей")
    return {
        "success": True,
        "document_id": doc.id,
        "title": doc.title,
        "view_url": f"/documents/{doc.id}/view",
        "download_url": f"/api/documents/{doc.id}/download",
        "summary": "; ".join(preview) or "справка сформирована",
    }


@router.post("/inventory/build")
async def inventory_build(
    file: UploadFile = File(...),
    all_categories: bool = Form(default=False),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Б4: отчёт «Принято уволено» → xlsx-опись личных дел уволенных
    (без повторно принятых; дата увольнения = дата записи − 1 день)."""
    from services.documents.dismissed_inventory import create_inventory

    tmp = await _save_upload_tmp(file, _XL_EXT)
    try:
        try:
            doc, result = create_inventory(db, user, tmp, all_categories=all_categories)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(500, f"Не удалось сформировать опись: {e}")
    finally:
        _unlink_quiet(tmp)
    return {
        "success": True,
        "document_id": doc.id,
        "title": doc.title,
        "download_url": f"/api/documents/{doc.id}/download",
        "year": result["year"],
        "count": len(result["items"]),
        "fired_total": result["fired_total"],
        "skipped_rehired": result["skipped_rehired"],
        "items": result["items"][:200],
    }


@router.post("/pps/announcement")
async def pps_announcement(
    files: list[UploadFile] = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Б5: выгрузки «Форма 2» (по одному файлу на должность) → word-объявление
    о выборах заведующих кафедрами и конкурсе ППС."""
    from services.documents.pps_announcement import create_announcement

    if not files:
        raise HTTPException(400, "Прикрепите хотя бы один файл «Форма 2»")
    if len(files) > 20:
        raise HTTPException(400, "Не больше 20 файлов за раз")
    tmps: list[str] = []
    try:
        for f in files:
            tmps.append(await _save_upload_tmp(f, _XL_EXT))
        try:
            doc, data = create_announcement(db, user, tmps)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(500, f"Не удалось сформировать объявление: {e}")
    finally:
        _unlink_quiet(*tmps)
    return {
        "success": True,
        "document_id": doc.id,
        "title": doc.title,
        "view_url": f"/documents/{doc.id}/view",
        "download_url": f"/api/documents/{doc.id}/download",
        "date": data["date"],
        "positions": data["positions"],
        "departments": data["departments"],
        "people": data["people"],
        "sections": [
            {"header": h.replace("\n", " "), "count": len(lines)}
            for h, lines in data["sections"]
        ],
    }
