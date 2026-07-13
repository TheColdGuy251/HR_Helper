from __future__ import annotations

import io
import re
import shutil
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session

from data.doc_templates import DocTemplate
from data.template_categories import TemplateCategory

from config import settings
from data.db_session import get_db
from data.kb_documents import KBDocument
from data.kb_sources import KBSource
from data.users import User
from services.rag.indexer import get_indexer, get_progress
from utils.auth_deps import require_kb_editor, require_user
from utils.logger import logger

router = APIRouter(prefix="/api/kb", tags=["knowledge-base"])

_KB_IMPORT_EXT = (
    ".pdf", ".docx", ".doc", ".txt", ".md", ".rst", ".csv", ".xlsx", ".xlsm",
    ".rtf", ".odt", ".xls", ".ods", ".pptx", ".ppt", ".odp",
)
_KB_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024
_KB_IMPORT_MAX_FILES = 500


# Пул фоновой индексации: не более одного документа за раз. Раньше каждый файл
# (в т.ч. каждый из сотен файлов 1С-архива) порождал собственный демон-поток и
# SQLite-сессию — это «клало» CPU и вызывало блокировки БД. Теперь задания встают
# в очередь и обрабатываются последовательно.
_INDEX_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kb-index")


def _index_in_background(doc_id: int, path: str) -> None:
    from data.db_session import create_session

    s = create_session()
    try:
        get_indexer().index_pending(s, doc_id, path)
    finally:
        s.close()


def _submit_index(doc_id: int, path: str) -> None:
    """Ставит документ в очередь фоновой индексации (последовательный воркер)."""
    _INDEX_POOL.submit(_index_in_background, doc_id, path)


def _index_url_background(source_id: int, url: str) -> None:
    """Фоновый парсинг+индексация веб-источника сразу после добавления. Обновляет
    статус источника; ошибки не роняют сервис."""
    from datetime import datetime

    from data.db_session import create_session

    s = create_session()
    try:
        try:
            get_indexer().index_url(s, url)
            status = "ok"
        except Exception as e:
            logger.warning("Индексация источника {} не удалась: {}", url, e)
            status = f"error: {str(e)[:200]}"
        src = s.get(KBSource, source_id)
        if src:
            src.last_crawled_at = datetime.utcnow()
            src.last_status = status
            s.commit()
    finally:
        s.close()


def _submit_index_url(source_id: int, url: str) -> None:
    _INDEX_POOL.submit(_index_url_background, source_id, url)


def _review_status(d: KBDocument) -> str | None:
    """Актуальность документа (А: ежегодный пересмотр, срок жизни 3–5 лет).
    'expired' — вышел срок действия (effective_to в прошлом);
    'review_due' — не пересматривался больше года (по дате действия/индексации);
    None — свежий или архивный (архив вне выдачи, отдельная метка)."""
    from datetime import date, timedelta

    if d.is_archived:
        return None
    today = date.today()
    if d.effective_to and d.effective_to < today:
        return "expired"
    # Опорная дата «последнего пересмотра»
    ref = d.effective_from
    if ref is None and d.indexed_at:
        ref = d.indexed_at.date()
    if ref is None and d.created_at:
        ref = d.created_at.date()
    if ref is not None and (today - ref) > timedelta(days=365):
        return "review_due"
    return None


def _unique_path(target_dir: Path, filename: str) -> Path:
    """Не перезатираем уже существующий файл с тем же именем."""
    base = Path(filename).stem
    ext = Path(filename).suffix
    candidate = target_dir / filename
    i = 1
    while candidate.exists():
        candidate = target_dir / f"{base} ({i}){ext}"
        i += 1
    return candidate


@router.get("/documents")
async def list_documents(user: User = Depends(require_user), db: Session = Depends(get_db)):
    docs = db.query(KBDocument).order_by(KBDocument.created_at.desc()).all()
    return {
        "success": True,
        "items": [
            {
                "id": d.id,
                "title": d.title,
                "filename": (d.extra or {}).get("filename")
                or (Path(d.source_uri).name if d.source_type == "local" and d.source_uri else None),
                "source_type": d.source_type,
                "source_uri": d.source_uri,
                "status": d.status,
                "priority": d.priority,
                "document_kind": d.document_kind,
                "issuer": d.issuer,
                "effective_from": d.effective_from.isoformat() if d.effective_from else None,
                "effective_to": d.effective_to.isoformat() if d.effective_to else None,
                "tags": d.tags or [],
                "is_archived": d.is_archived,
                "review_status": _review_status(d),
                "chunks_count": d.chunks_count,
                # Живой прогресс индексации (стадия, N/M чанков, %) — только пока идёт
                "progress": get_progress(d.id) if d.status in ("pending", "parsing") else None,
                "ocr_applied": bool((d.extra or {}).get("ocr_applied")),
                # А8: признаки ПДн в документе общей БЗ ({fio_count, reason, samples})
                "pii_warning": (d.extra or {}).get("pii_warning"),
                "created_at": d.created_at.isoformat(),
                "indexed_at": d.indexed_at.isoformat() if d.indexed_at else None,
                "error": d.error,
            }
            for d in docs
        ],
    }


@router.post("/upload")
async def upload(
    file: UploadFile = File(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    suffix = Path(file.filename or "").suffix.lower()
    allowed = (
        ".pdf", ".docx", ".doc", ".txt", ".md", ".rst", ".csv", ".xlsx", ".xlsm",
        ".rtf", ".odt", ".xls", ".ods", ".pptx", ".ppt", ".odp",
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff",
    )
    if suffix not in allowed:
        raise HTTPException(400, f"Неподдерживаемый формат: {suffix}")

    target_dir = settings.docs_local
    target_dir.mkdir(parents=True, exist_ok=True)
    # Не перезатираем существующий файл с тем же именем (на него может
    # ссылаться уже проиндексированный документ); дубли отсечёт хеш при индексации.
    target = _unique_path(target_dir, Path(file.filename or "document").name)
    with target.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    # Создаём pending-запись синхронно (сразу видна в списке), а тяжёлый
    # парсинг/эмбеддинги уносим в фоновый поток — сервис не блокируется.
    try:
        indexer = get_indexer()
        doc = indexer.create_pending_file(db, target)
    except Exception as e:
        logger.exception("Не удалось зарегистрировать документ: {}", e)
        raise HTTPException(500, f"Ошибка загрузки: {e}")

    _submit_index(doc.id, str(target))

    return {
        "success": True,
        "queued": True,
        "document": {"id": doc.id, "title": doc.title, "status": "pending"},
    }


@router.post("/import/1c")
async def import_1c_documents(
    file: UploadFile = File(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    """Импорт документов из файловой выгрузки 1С (ZIP-архив). Каждый поддерживаемый
    файл сохраняется в docs/local и индексируется в фоне (#18)."""
    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "Ожидается ZIP-архив выгрузки 1С")

    data = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Файл не является корректным ZIP-архивом")

    target_dir = settings.docs_local
    target_dir.mkdir(parents=True, exist_ok=True)

    queued: list[int] = []
    skipped = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        if len(queued) >= _KB_IMPORT_MAX_FILES:
            break
        # Берём только имя файла (защита от путей вида ../../)
        fname = Path(info.filename).name
        if not fname or Path(fname).suffix.lower() not in _KB_IMPORT_EXT:
            skipped += 1
            continue
        if info.file_size > _KB_IMPORT_MAX_FILE_BYTES:
            skipped += 1
            continue
        try:
            content = zf.read(info)
        except Exception:
            skipped += 1
            continue
        target = _unique_path(target_dir, fname)
        try:
            target.write_bytes(content)
            doc = get_indexer().create_pending_file(db, target)
        except Exception as e:
            logger.warning("1С-импорт: пропуск {}: {}", fname, e)
            skipped += 1
            continue
        queued.append(doc.id)
        _submit_index(doc.id, str(target))

    logger.info("1С-импорт документов: поставлено {} , пропущено {}", len(queued), skipped)
    return {"success": True, "queued": len(queued), "skipped": skipped, "ids": queued}


@router.post("/index-url")
async def index_url(
    body: dict = Body(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    url = body.get("url")
    if not url:
        raise HTTPException(400, "URL не указан")
    try:
        doc = get_indexer().index_url(db, url)
    except Exception as e:
        raise HTTPException(500, f"Не удалось проиндексировать URL: {e}")
    return {"success": True, "document": {"id": doc.id, "title": doc.title, "chunks": doc.chunks_count}}


@router.delete("/documents/{doc_id}")
async def delete_document(
    doc_id: int,
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    get_indexer().delete_document(db, doc_id)
    return {"success": True}


@router.patch("/documents/{doc_id}")
async def patch_document(
    doc_id: int,
    body: dict = Body(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    from datetime import datetime as _dt

    doc = db.get(KBDocument, doc_id)
    if not doc:
        raise HTTPException(404, "Документ не найден")

    if "priority" in body:
        new_p = int(body["priority"])
        if new_p not in (1, 2, 3):
            raise HTTPException(400, "priority должен быть 1, 2 или 3")
        doc.priority = new_p
        try:
            from services.vectorstore import get_store
            get_store().set_priority(doc.id, new_p)
        except Exception as e:
            logger.warning("Qdrant set_priority failed: {}", e)

    if "title" in body and body["title"]:
        doc.title = str(body["title"]).strip()

    if "document_kind" in body:
        v = body["document_kind"]
        if v in (None, "", "none"):
            doc.document_kind = None
        elif v in ("code", "law", "regulation", "order", "manual", "other"):
            doc.document_kind = v
        else:
            raise HTTPException(400, "document_kind: code|law|regulation|order|manual|other")

    if "issuer" in body:
        doc.issuer = (str(body["issuer"]).strip() or None) if body["issuer"] else None

    for fld in ("effective_from", "effective_to"):
        if fld in body:
            v = body[fld]
            if not v:
                setattr(doc, fld, None)
            else:
                try:
                    setattr(doc, fld, _dt.strptime(str(v).strip(), "%Y-%m-%d").date())
                except ValueError:
                    raise HTTPException(400, f"{fld}: формат YYYY-MM-DD")

    if "tags" in body:
        tags = body["tags"] or []
        if not isinstance(tags, list):
            raise HTTPException(400, "tags должен быть массивом строк")
        doc.tags = [str(t).strip() for t in tags if str(t).strip()][:20] or None

    if "is_archived" in body:
        doc.is_archived = bool(body["is_archived"])

    db.commit()

    # Если изменились теги/архив/тип — обновим payload чанков в Qdrant
    if any(k in body for k in ("tags", "is_archived", "document_kind")):
        try:
            from services.vectorstore import get_store
            from qdrant_client import models as qm
            store = get_store()
            store.client.set_payload(
                collection_name=store.collection,
                payload={
                    "is_archived": bool(doc.is_archived),
                    "document_kind": doc.document_kind,
                    "tags": list(doc.tags or []),
                },
                # qdrant-client ≥1.11: параметр называется points (не points_selector).
                points=qm.Filter(must=[
                    qm.FieldCondition(key="document_id", match=qm.MatchValue(value=doc.id))
                ]),
                wait=True,
            )
        except Exception as e:
            logger.warning("Qdrant payload sync failed: {}", e)

    return {
        "success": True,
        "document": {
            "id": doc.id,
            "title": doc.title,
            "priority": doc.priority,
            "document_kind": doc.document_kind,
            "issuer": doc.issuer,
            "effective_from": doc.effective_from.isoformat() if doc.effective_from else None,
            "effective_to": doc.effective_to.isoformat() if doc.effective_to else None,
            "tags": doc.tags or [],
            "is_archived": doc.is_archived,
        },
    }


@router.patch("/sources/{source_id}")
async def patch_source(
    source_id: int,
    body: dict = Body(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    src = db.get(KBSource, source_id)
    if not src:
        raise HTTPException(404, "Источник не найден")
    if "priority" in body:
        new_p = int(body["priority"])
        if new_p not in (1, 2, 3):
            raise HTTPException(400, "priority должен быть 1, 2 или 3")
        src.priority = new_p
    if "is_enabled" in body:
        src.is_enabled = bool(body["is_enabled"])
    db.commit()
    return {"success": True}


@router.get("/documents/{doc_id}/download")
async def download_document(
    doc_id: int,
    inline: bool = Query(default=False),
    as_: str | None = Query(default=None, alias="as"),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    doc = db.get(KBDocument, doc_id)
    if not doc:
        raise HTTPException(404, "Документ не найден")

    # Веб-источники открываем по оригинальному URL
    if doc.source_type == "web":
        if not doc.source_uri:
            raise HTTPException(404, "URL источника отсутствует")
        return RedirectResponse(url=doc.source_uri, status_code=302)

    # Локальные файлы — отдаём из docs/local
    path = Path(doc.source_uri)
    # Защита от path-traversal: разрешаем только файлы внутри docs/
    try:
        path = path.resolve()
        path.relative_to(settings.docs_dir.resolve())
    except (ValueError, OSError):
        raise HTTPException(403, "Доступ к файлу запрещён")
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "Файл отсутствует на диске")

    # as=pdf — отдаём PDF-версию презентации (pptx/ppt/odp) для предпросмотра
    if as_ == "pdf":
        from utils.file_preview import preview_pdf_response

        resp = preview_pdf_response(path)
        if resp is not None:
            return resp

    # inline=1 — показать в браузере (для PDF в iframe просмотрщика); иначе скачать
    return FileResponse(
        path,
        filename=path.name,
        media_type=doc.mime_type or "application/octet-stream",
        content_disposition_type="inline" if inline else "attachment",
    )


@router.get("/sources")
async def list_sources(user: User = Depends(require_user), db: Session = Depends(get_db)):
    items = db.query(KBSource).order_by(KBSource.id.asc()).all()
    # Проиндексированный документ для каждого URL (для предпросмотра «что распарсилось»).
    docs = (
        db.query(KBDocument)
        .filter(KBDocument.source_type == "web")
        .order_by(KBDocument.id.desc())
        .all()
    )
    doc_by_url: dict[str, KBDocument] = {}
    for d in docs:
        doc_by_url.setdefault(d.source_uri, d)  # самый свежий (id desc)

    out = []
    for s in items:
        d = doc_by_url.get(s.url)
        out.append({
            "id": s.id,
            "name": s.name,
            "url": s.url,
            "is_enabled": s.is_enabled,
            "priority": s.priority,
            "refresh_interval_hours": s.refresh_interval_hours,
            "last_crawled_at": s.last_crawled_at.isoformat() if s.last_crawled_at else None,
            "last_status": s.last_status,
            "document_id": d.id if d else None,
            "doc_status": d.status if d else None,
            "chunks_count": d.chunks_count if d else 0,
        })
    return {"success": True, "items": out}


@router.post("/sources")
async def create_source(
    body: dict = Body(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    name = body.get("name")
    url = body.get("url")
    if not name or not url:
        raise HTTPException(400, "name и url обязательны")
    src = KBSource(
        name=name,
        url=url,
        refresh_interval_hours=int(body.get("refresh_interval_hours") or 24),
    )
    db.add(src)
    db.commit()
    db.refresh(src)
    # Начинаем парсинг СРАЗУ (в фоне), не дожидаясь планировщика.
    _submit_index_url(src.id, url)
    return {"success": True, "id": src.id, "queued": True}


@router.delete("/sources/{source_id}")
async def delete_source(
    source_id: int,
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    src = db.get(KBSource, source_id)
    if src:
        # Полностью удаляем проиндексированные документы этого источника
        # (векторы Qdrant + BM25 + граф ссылок kb_links + запись БД).
        docs = (
            db.query(KBDocument)
            .filter(KBDocument.source_uri == src.url, KBDocument.source_type == "web")
            .all()
        )
        indexer = get_indexer()
        for d in docs:
            try:
                indexer.delete_document(db, d.id)
            except Exception as e:
                logger.warning("Не удалось удалить документ источника {}: {}", src.url, e)
        db.delete(src)
        db.commit()
    return {"success": True}


# ---------------------------------------------------------------------------
# Шаблоны HR-документов (.docx с {{переменными}})
# ---------------------------------------------------------------------------


def _slugify(s: str) -> str:
    s = re.sub(r"[^\w\-]+", "_", s.strip(), flags=re.UNICODE)
    return s.strip("_").lower()[:64] or "template"


def _extract_template_fields(docx_path: Path) -> list[str]:
    """Извлекает все {{переменные}} из docx через docxtpl."""
    from docxtpl import DocxTemplate

    doc = DocxTemplate(str(docx_path))
    try:
        from jinja2 import Environment

        env = Environment()
        return sorted(doc.get_undeclared_template_variables(env))
    except Exception:
        try:
            return sorted(doc.get_undeclared_template_variables())
        except Exception as e:
            logger.warning("Не удалось разобрать переменные шаблона: {}", e)
            return []


@router.get("/template-categories")
async def list_template_categories(
    user: User = Depends(require_user), db: Session = Depends(get_db)
):
    cats = db.query(TemplateCategory).order_by(TemplateCategory.sort_order.asc()).all()
    return {
        "success": True,
        "items": [
            {
                "id": c.id,
                "slug": c.slug,
                "name": c.name,
                "icon": c.icon,
                "sort_order": c.sort_order,
                "default_template_id": c.default_template_id,
            }
            for c in cats
        ],
    }


@router.post("/template-categories/{category_id}/default")
async def set_default_template(
    category_id: int,
    body: dict = Body(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    cat = db.get(TemplateCategory, category_id)
    if not cat:
        raise HTTPException(404, "Категория не найдена")
    template_id = body.get("template_id")
    if template_id is not None:
        tpl = db.get(DocTemplate, template_id)
        if not tpl or tpl.category_id != category_id:
            raise HTTPException(400, "Шаблон не принадлежит этой категории")
        cat.default_template_id = template_id
    else:
        cat.default_template_id = None
    db.commit()
    return {"success": True}


@router.get("/templates")
async def list_templates(user: User = Depends(require_user), db: Session = Depends(get_db)):
    items = db.query(DocTemplate).order_by(DocTemplate.created_at.desc()).all()
    return {
        "success": True,
        "items": [
            {
                "id": t.id,
                "key": t.key,
                "title": t.title,
                "description": t.description,
                "is_enabled": t.is_enabled,
                "category_id": t.category_id,
                "fields_count": len(t.fields_schema or []),
                "fields": t.fields_schema or [],
                "created_at": t.created_at.isoformat(),
            }
            for t in items
        ],
    }


@router.patch("/templates/{template_id}")
async def patch_template(
    template_id: int,
    body: dict = Body(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    tpl = db.get(DocTemplate, template_id)
    if not tpl:
        raise HTTPException(404, "Шаблон не найден")
    if "category_id" in body:
        cid = body["category_id"]
        if cid is not None:
            cat = db.get(TemplateCategory, cid)
            if not cat:
                raise HTTPException(400, "Категория не найдена")
        tpl.category_id = cid
    if "title" in body and body["title"]:
        tpl.title = body["title"]
    if "description" in body:
        tpl.description = body["description"]
    if "is_enabled" in body:
        tpl.is_enabled = bool(body["is_enabled"])

    # Точечная правка схемы полей: пометить поле обязательным/опциональным, задать
    # тип (например, number для оклада) или подпись. Мержим по имени поля — так
    # управляется поведение «спрашивать недостающее» и «пустое вместо None».
    if "fields" in body:
        incoming = body["fields"]
        if not isinstance(incoming, list):
            raise HTTPException(400, "fields должен быть массивом объектов")
        existing = {f.get("name"): dict(f) for f in (tpl.fields_schema or []) if f.get("name")}
        for item in incoming:
            if not isinstance(item, dict):
                continue
            name = (item.get("name") or "").strip()
            f = existing.get(name)
            if not f:
                continue
            if "required" in item:
                f["required"] = bool(item["required"])
            if "optional" in item:  # синоним-антоним для удобства фронта
                f["required"] = not bool(item["optional"])
            if item.get("type"):
                f["type"] = str(item["type"])
            if item.get("label"):
                f["label"] = str(item["label"])
            if "hint" in item:
                f["hint"] = item["hint"]
        tpl.fields_schema = list(existing.values())

    db.commit()
    return {"success": True}


@router.post("/templates")
async def upload_template(
    file: UploadFile = File(...),
    title: str = Form(...),
    description: str | None = Form(default=None),
    key: str | None = Form(default=None),
    category_id: int | None = Form(default=None),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in (".docx", ".doc", ".pdf"):
        raise HTTPException(400, "Поддерживаются .docx, .doc и .pdf")

    target_dir = settings.docs_templates
    target_dir.mkdir(parents=True, exist_ok=True)

    safe_name = Path(file.filename or "template.docx").name
    target = target_dir / safe_name
    # При коллизии добавляем суффикс
    n = 1
    while target.exists():
        target = target_dir / f"{Path(safe_name).stem}_{n}{suffix}"
        n += 1

    with target.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    # .doc → конвертируем в .docx (LibreOffice), дальше работаем как с .docx.
    if suffix == ".doc":
        try:
            from services.parsers.office_convert import convert_to_modern

            conv = convert_to_modern(target)
            final = target.with_suffix(".docx")
            m = 1
            while final.exists():
                final = target_dir / f"{target.stem}_{m}.docx"
                m += 1
            shutil.move(str(conv), str(final))
            shutil.rmtree(conv.parent, ignore_errors=True)
            target.unlink(missing_ok=True)
            target = final
            suffix = ".docx"
        except Exception as e:
            target.unlink(missing_ok=True)
            raise HTTPException(400, f"Не удалось конвертировать .doc (нужен LibreOffice): {e}")

    from services.documents.intent import ru_field_label

    if suffix == ".pdf":
        # PDF-шаблон нельзя заполнять переменными — это справочная форма
        # (доступна для предпросмотра и скачивания). Полей нет.
        fields_schema: list[dict] = []
    else:
        try:
            variables = _extract_template_fields(target)
        except Exception as e:
            target.unlink(missing_ok=True)
            raise HTTPException(400, f"Не удалось разобрать шаблон: {e}")

        if variables:
            # Обычный шаблон с {{переменными}}.
            fields_schema = [
                {
                    "name": v,
                    "label": ru_field_label(v, v.replace("_", " ").capitalize()),
                    "type": "string",
                    "required": True,
                }
                for v in variables
            ]
        else:
            # Бланк БЕЗ переменных → авто-определяем поля (autofill).
            from services.documents.generator import auto_field_schema

            fields_schema = auto_field_schema(str(target))

    template_key = key or _slugify(title)
    # Уникальность ключа
    if db.query(DocTemplate).filter(DocTemplate.key == template_key).first():
        template_key = f"{template_key}_{n}"

    # Если категория не указана — пробуем «Прочее».
    if category_id is None:
        other = db.query(TemplateCategory).filter(TemplateCategory.slug == "other").first()
        category_id = other.id if other else None

    tpl = DocTemplate(
        key=template_key,
        title=title,
        description=description,
        file_path=str(target),
        fields_schema=fields_schema,
        category_id=category_id,
    )
    db.add(tpl)
    db.commit()
    db.refresh(tpl)
    return {
        "success": True,
        "template": {
            "id": tpl.id,
            "key": tpl.key,
            "title": tpl.title,
            "fields_count": len(fields_schema),
        },
    }


@router.delete("/templates/{template_id}")
async def delete_template(
    template_id: int,
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    tpl = db.get(DocTemplate, template_id)
    if not tpl:
        raise HTTPException(404, "Шаблон не найден")
    try:
        Path(tpl.file_path).unlink(missing_ok=True)
    except Exception:
        pass
    db.delete(tpl)
    db.commit()
    return {"success": True}


_TEMPLATE_MIME = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf": "application/pdf",
}


@router.get("/templates/{template_id}/download")
async def download_template(
    template_id: int,
    inline: bool = Query(default=False),
    as_: str | None = Query(default=None, alias="as"),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    tpl = db.get(DocTemplate, template_id)
    if not tpl:
        raise HTTPException(404, "Шаблон не найден")
    # Показываем/скачиваем версию с подставленными названиями авто-полей (для бланка
    # без переменных); для jinja-docx и pdf — оригинал.
    from services.documents.generator import template_display_path

    try:
        path = template_display_path(tpl).resolve()
        path.relative_to(settings.docs_dir.resolve())
    except (ValueError, OSError):
        raise HTTPException(403, "Доступ к файлу запрещён")
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "Файл шаблона отсутствует")
    if as_ == "pdf":
        from utils.file_preview import preview_pdf_response

        resp = preview_pdf_response(path)
        if resp is not None:
            return resp
    # Имя для скачивания — по оригиналу (у превью-файла имя = id).
    dl_name = Path(tpl.file_path).name
    media = _TEMPLATE_MIME.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(
        path,
        filename=dl_name,
        media_type=media,
        content_disposition_type="inline" if inline else "attachment",
    )


# ---------------------------------------------------------------------------
# FAQ отдела кадров (А2/А6): просмотр и правка курируемых записей
# ---------------------------------------------------------------------------


@router.get("/faq")
async def list_faq(user: User = Depends(require_kb_editor), db: Session = Depends(get_db)):
    from data.faq_entries import FAQEntry

    rows = (
        db.query(FAQEntry)
        .order_by(FAQEntry.source_file, FAQEntry.group_key, FAQEntry.position)
        .all()
    )
    return {
        "success": True,
        "items": [
            {
                "id": r.id,
                "group_key": r.group_key,
                "position": r.position,
                "source_file": r.source_file,
                "block": r.block,
                "variants": r.variants or [],
                "clarify_question": r.clarify_question,
                "option_label": r.option_label,
                "answer": r.answer,
                "doc_refs": r.doc_refs or [],
                "contact": r.contact,
                "is_active": r.is_active,
            }
            for r in rows
        ],
    }


@router.patch("/faq/{entry_id}")
async def patch_faq(
    entry_id: int,
    body: dict,
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    from data.faq_entries import FAQEntry
    from services.rag.faq import get_matcher

    row = db.get(FAQEntry, entry_id)
    if not row:
        raise HTTPException(404, "FAQ-запись не найдена")
    if "answer" in body:
        row.answer = str(body["answer"] or "")
    if "contact" in body:
        row.contact = (str(body["contact"]).strip() or None) if body["contact"] else None
    if "variants" in body:
        vs = [str(v).strip() for v in (body["variants"] or []) if str(v).strip()]
        row.variants = vs or None
    if "clarify_question" in body:
        cq = str(body["clarify_question"] or "").strip()
        row.clarify_question = cq or None
    if "option_label" in body:
        ol = str(body["option_label"] or "").strip()
        row.option_label = ol or None
    if "is_active" in body:
        row.is_active = bool(body["is_active"])
    db.commit()
    get_matcher().invalidate()  # прототипы пересчитаются при следующем запросе
    return {"success": True}


@router.delete("/faq/{entry_id}")
async def delete_faq(
    entry_id: int,
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    from data.faq_entries import FAQEntry
    from services.rag.faq import get_matcher

    row = db.get(FAQEntry, entry_id)
    if not row:
        raise HTTPException(404, "FAQ-запись не найдена")
    db.delete(row)
    db.commit()
    get_matcher().invalidate()
    return {"success": True}


@router.post("/faq/import")
async def import_faq(
    files: list[UploadFile] = File(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    """Полный реимпорт FAQ из загруженных файлов «чат-бот …» (docx/doc).
    ВНИМАНИЕ: заменяет все существующие записи (включая ручные правки)."""
    import tempfile

    from services.rag.faq import import_faq_files

    if not files:
        raise HTTPException(400, "Прикрепите файлы «чат-бот …» (docx/doc)")
    tmpdir = Path(tempfile.mkdtemp(prefix="faq_import_"))
    paths: list[Path] = []
    for f in files:
        suffix = Path(f.filename or "").suffix.lower()
        if suffix not in (".docx", ".doc"):
            raise HTTPException(400, f"Неподдерживаемый формат: {f.filename}")
        data = await f.read()
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(400, f"Файл больше 20 МБ: {f.filename}")
        p = tmpdir / (Path(f.filename).name or "faq.docx")
        p.write_bytes(data)
        paths.append(p)
    try:
        stats = import_faq_files(paths, db)
    except Exception as e:
        raise HTTPException(500, f"Не удалось импортировать FAQ: {e}")
    finally:
        for p in paths:
            try:
                p.unlink()
            except OSError:
                pass
    return {"success": True, **stats}


# ---------------------------------------------------------------------------
# Доступы (А6): назначение роли «редактор БЗ» — только администратор
# ---------------------------------------------------------------------------


@router.get("/users")
async def list_users_roles(user: User = Depends(require_user), db: Session = Depends(get_db)):
    if not user.is_admin:
        raise HTTPException(403, "Доступно только администратору")
    rows = db.query(User).filter(User.is_active.is_(True)).order_by(User.surname, User.name).all()
    return {
        "success": True,
        "items": [
            {
                "id": u.id,
                "full_name": u.full_name,
                "username": u.username,
                "position": u.position,
                "is_admin": u.is_admin,
                "is_kb_editor": u.is_kb_editor,
            }
            for u in rows
        ],
    }


@router.patch("/users/{user_id}/roles")
async def patch_user_roles(
    user_id: int,
    body: dict,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    if not user.is_admin:
        raise HTTPException(403, "Доступно только администратору")
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "Пользователь не найден")
    if "is_kb_editor" in body:
        target.is_kb_editor = bool(body["is_kb_editor"])
    db.commit()
    return {"success": True, "is_kb_editor": target.is_kb_editor}


# ---------------------------------------------------------------------------
# А6: правка текста документа БЗ из UI (с полной переиндексацией)
# ---------------------------------------------------------------------------


@router.patch("/documents/{doc_id}/content")
async def edit_document_content(
    doc_id: int,
    body: dict = Body(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    """Заменяет извлечённый текст документа и переиндексирует его в фоне
    (статус и прогресс — как при обычной загрузке). Название и метаданные
    сохраняются; исходный файл на диске НЕ меняется — правка живёт в БЗ."""
    text = str(body.get("content") or "").strip()
    if len(text) < 20:
        raise HTTPException(400, "Текст слишком короткий (минимум 20 символов)")
    if len(text) > 5_000_000:
        raise HTTPException(400, "Текст больше 5 млн символов")

    doc = db.get(KBDocument, doc_id)
    if not doc:
        raise HTTPException(404, "Документ не найден")
    if doc.status in ("pending", "parsing"):
        raise HTTPException(409, "Документ сейчас индексируется — дождитесь завершения")

    doc.status = "pending"
    doc.error = None
    db.commit()

    import threading

    from data.db_session import create_session

    def _job() -> None:
        db2 = create_session()
        try:
            get_indexer().reindex_content(db2, doc_id, text)
        except Exception as e:
            logger.warning("[KB] переиндексация после правки doc {} упала: {}", doc_id, e)
        finally:
            db2.close()

    threading.Thread(target=_job, daemon=True).start()
    return {"success": True, "status": "pending"}


@router.get("/documents/{doc_id}/content")
async def get_document_content(
    doc_id: int,
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    """Извлечённый текст документа для редактора (А6)."""
    doc = db.get(KBDocument, doc_id)
    if not doc:
        raise HTTPException(404, "Документ не найден")
    return {"success": True, "content": doc.content or "", "title": doc.title}
