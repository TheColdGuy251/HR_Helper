from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session

from config import settings
from data.db_session import get_db
from data.kb_documents import KBDocument
from data.my_documents import MyDocuments
from data.users import User
from utils.auth_deps import require_user_redirect
from utils.logger import logger
from utils.markdown import md_to_html
from utils.templating import render

router = APIRouter(tags=["pages"])

_STATIC_DIR = Path(settings.base_dir) / "static"


# ─────────────────────────── PWA (публично, без авторизации) ───────────────────────────
@router.get("/sw.js", include_in_schema=False)
async def service_worker():
    # Service worker с корневой областью (/) — управляет всем сайтом.
    return FileResponse(
        _STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


@router.get("/manifest.webmanifest", include_in_schema=False)
async def web_manifest():
    return FileResponse(
        _STATIC_DIR / "manifest.webmanifest",
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/offline.html", include_in_schema=False)
async def offline_page():
    return FileResponse(_STATIC_DIR / "offline.html", media_type="text/html")


@router.get("/", name="page_home")
async def home(
    request: Request,
    user: User = Depends(require_user_redirect),
    db: Session = Depends(get_db),
):
    docs = (
        db.query(MyDocuments)
        .filter(MyDocuments.user_id == user.id)
        .order_by(MyDocuments.last_activity.desc())
        .limit(12)
        .all()
    )
    documents = [
        {
            "title": d.title,
            "progress": d.progress,
            "status": d.status,
            "last_activity": d.last_activity,
            "template_key": d.template_key,
            "id": d.id,
        }
        for d in docs
    ]
    return render(
        request,
        "index.html",
        {"documents": documents, "documents_count": len(documents)},
    )


@router.get("/dialogues", name="page_dialogues")
async def dialogues_page(request: Request, user: User = Depends(require_user_redirect)):
    return render(request, "dialogues.html", {})


@router.get("/kb", name="page_kb")
async def kb_page(request: Request, user: User = Depends(require_user_redirect)):
    return render(request, "kb.html", {})


@router.get("/news", name="page_news")
async def news_page(request: Request, user: User = Depends(require_user_redirect)):
    can_edit = bool(getattr(user, "is_admin", False) or getattr(user, "is_kb_editor", False))
    return render(request, "news.html", {"can_edit": can_edit})


@router.get("/news/media/{media_id}/view", name="page_news_media_view")
async def news_media_view(
    request: Request,
    media_id: int,
    user: User = Depends(require_user_redirect),
    db: Session = Depends(get_db),
):
    """Предпросмотр прикреплённого к новости файла (pdf/docx/xlsx/txt/… — как в
    мессенджере, через общий _build_view_ctx + document_view.html)."""
    from data.news import NewsMedia

    m = db.get(NewsMedia, media_id)
    base = f"/api/news/media/{media_id}"
    if not m:
        return render(request, "document_view.html",
                      {"title": "Файл", "download_url": base, "mode": "missing"})
    ctx = _build_view_ctx(m.stored_path, m.original_name, base)
    ctx["download_url"] = f"{base}?download=1"
    if ctx.get("mode") == "pdf":
        return RedirectResponse(url=ctx["inline_url"], status_code=302)
    return render(request, "document_view.html", ctx)


@router.get("/news/{post_id}", name="page_news_article")
async def news_article_page(
    request: Request,
    post_id: int,
    user: User = Depends(require_user_redirect),
    db: Session = Depends(get_db),
):
    """Отдельная страница новости — полный текст статьи (тело уже санитизировано
    при сохранении, отдаём как есть с |safe в шаблоне)."""
    from data.news import NewsPost

    post = db.get(NewsPost, post_id)
    if not post or not post.is_published:
        return RedirectResponse(url="/news", status_code=302)
    author = db.get(User, post.author_id) if post.author_id else None
    can_edit = bool(user.is_admin or user.is_kb_editor)
    return render(request, "news_article.html", {
        "post": {
            "id": post.id,
            "title": post.title,
            "body_html": post.body_html,
            "author": author.full_name if author else "—",
            "is_pinned": post.is_pinned,
            "created_at": post.created_at,
            "updated_at": post.updated_at,
        },
        "can_edit": can_edit,
    })


@router.get("/messenger", name="page_messenger")
async def messenger_page(request: Request, user: User = Depends(require_user_redirect)):
    return render(request, "messenger.html", {})


@router.get("/messenger/files/{file_id}/view", name="page_messenger_file_view")
async def messenger_file_view(
    request: Request,
    file_id: int,
    user: User = Depends(require_user_redirect),
    db: Session = Depends(get_db),
):
    """Страница предпросмотра файла из мессенджера (pdf/docx/xlsx/текст — как в /kb)."""
    from data.user_message import UserMessageFile

    rec = db.get(UserMessageFile, file_id)
    base = f"/api/messenger/files/{file_id}"
    if not rec:
        return render(request, "document_view.html",
                      {"title": "Файл", "download_url": base, "mode": "missing"})
    ctx = _build_view_ctx(rec.stored_path, rec.original_name, base)
    ctx["download_url"] = f"{base}?download=1"          # кнопка «Скачать» — принудительно
    if ctx.get("mode") == "pdf":
        return RedirectResponse(url=ctx["inline_url"], status_code=302)
    return render(request, "document_view.html", ctx)


def _build_view_ctx(source_uri: str | None, title: str, download_url: str) -> dict:
    """Готовит контекст шаблона просмотра по пути к локальному файлу.
    Режим: pdf (нативно), markdown, text (извлечённый), missing/forbidden/unsupported."""
    ctx: dict = {
        "title": title or "Документ",
        "download_url": download_url,
        "mode": "unsupported",
        "content": "",
        "content_html": "",
    }
    # Проверка пути (как при скачивании) — только внутри docs_dir
    try:
        path = Path(source_uri).resolve()
        path.relative_to(settings.docs_dir.resolve())
    except (ValueError, OSError, TypeError):
        ctx["mode"] = "forbidden"
        return ctx
    if not path.exists() or not path.is_file():
        ctx["mode"] = "missing"
        return ctx

    inline_url = f"{download_url}?inline=1"
    ext = path.suffix.lower()
    try:
        if ext == ".pdf":
            # Полностью нативный просмотр — без обёртки приложения (роут сделает redirect)
            ctx["mode"] = "pdf"
            ctx["inline_url"] = inline_url
        elif ext == ".md":
            ctx["mode"] = "markdown"
            ctx["content_html"] = md_to_html(path.read_text(encoding="utf-8", errors="ignore"))
        elif ext in (".txt", ".rst", ".csv", ".log"):
            ctx["mode"] = "text"
            ctx["content"] = path.read_text(encoding="utf-8", errors="ignore")
        elif ext == ".docx":
            # Полное оформление через mammoth.js (клиентский рендер из inline-байтов)
            ctx["mode"] = "docx"
            ctx["inline_url"] = inline_url
        elif ext in (".xlsx", ".xlsm", ".xls"):
            # Листы/таблицы через SheetJS
            ctx["mode"] = "xlsx"
            ctx["inline_url"] = inline_url
        elif ext in (".pptx", ".ppt", ".odp"):
            # Презентации: у браузера нет нативного просмотрщика — конвертируем в
            # PDF (LibreOffice, с кэшем) и показываем его нативно (роут → redirect).
            ctx["mode"] = "pdf"
            ctx["inline_url"] = f"{inline_url}&as=pdf"
        elif ext in (".doc", ".rtf", ".odt", ".ods"):
            # Старые форматы Office: конвертируем (LibreOffice) и показываем текст
            from services.parsers import parse_file
            ctx["mode"] = "text"
            ctx["content"] = parse_file(path).text
        else:
            ctx["mode"] = "unsupported"
    except Exception as e:
        logger.warning("document_view parse failed for {}: {}", source_uri, e)
        ctx["mode"] = "unsupported"
    return ctx


def _build_diff_html(old: str, new: str) -> str:
    """Построчный diff старого и нового текста страницы: новый/изменённый текст —
    красным (dvd-add), удалённый — зачёркнутым (dvd-del), без изменений — как есть."""
    import difflib
    import html as _html

    old_lines = (old or "").splitlines()
    new_lines = (new or "").splitlines()
    sm = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)

    def _esc(s: str) -> str:
        return _html.escape(s) if s.strip() else "&nbsp;"

    out: list[str] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.extend(f"<div class='dvd-line'>{_esc(x)}</div>" for x in new_lines[j1:j2])
            continue
        if tag in ("delete", "replace"):
            out.extend(f"<div class='dvd-line dvd-del'>{_esc(x)}</div>" for x in old_lines[i1:i2])
        if tag in ("insert", "replace"):
            out.extend(f"<div class='dvd-line dvd-add'>{_esc(x)}</div>" for x in new_lines[j1:j2])
    return "".join(out)


@router.get("/kb/documents/{doc_id}/view", name="page_doc_view")
async def document_view(
    request: Request,
    doc_id: int,
    diff: int | None = None,
    text: int | None = None,
    original: int | None = None,
    user: User = Depends(require_user_redirect),
    db: Session = Depends(get_db),
):
    """Страница предпросмотра документа базы знаний (pdf — нативно, остальное —
    извлечённый текст/markdown). Скачивание — отдельной кнопкой.
    ?diff=<notification_id> — сравнение с прежней версией веб-страницы
    (из системного уведомления об обновлении, изменения выделены красным).
    ?text=1 — принудительно текстовая версия (извлечённый текст);
    ?original=1 — принудительно оригинальное форматирование (docx-preview),
    даже для больших файлов."""
    doc = db.get(KBDocument, doc_id)
    download_url = f"/api/kb/documents/{doc_id}/download"
    if not doc:
        return render(request, "document_view.html",
                      {"title": "Документ", "download_url": download_url, "mode": "missing"})

    # А6: редактор БЗ может править извлечённый текст прямо со страницы просмотра
    can_edit = bool(
        (user.is_admin or user.is_kb_editor)
        and (doc.content or "").strip()
        and doc.status == "indexed"
    )
    edit_ctx = {"kb_doc_id": doc.id, "can_edit": can_edit}

    # ?text=1 — текстовая версия любого документа (извлечённый текст всегда
    # отображается, в отличие от тяжёлых/сложных оригиналов).
    if text and (doc.content or "").strip():
        return render(request, "document_view.html", {
            "title": doc.title or "Документ",
            "download_url": download_url,
            "mode": "text",
            "content": doc.content,
            "text_note": "Показан извлечённый текст документа (по нему ищет и отвечает бот).",
            "original_url": f"/kb/documents/{doc_id}/view?original=1",
            **edit_ctx,
        })

    if diff:
        from data.notifications import Notification

        n = db.get(Notification, diff)
        old_content = (n.extra or {}).get("old_content") if n else None
        if n and n.document_id == doc.id and old_content is not None:
            return render(request, "document_view.html", {
                "title": f"Обновление: {doc.title or 'Документ'}",
                "download_url": download_url,
                "mode": "diff",
                "content_html": _build_diff_html(old_content, doc.content or ""),
                "content": "",
                "source_url": doc.source_uri,
            })
    # Веб-источник: показываем, ЧТО РАСПАРСИЛОСЬ (сохранённый текст), с оформлением.
    # Файла на диске нет; если текст ещё не сохранён (старые записи) — открываем оригинал.
    if doc.source_type == "web":
        if doc.content:
            return render(request, "document_view.html", {
                "title": doc.title or "Документ",
                "download_url": download_url,  # для web → редирект на оригинал
                "mode": "markdown",
                "content_html": md_to_html(doc.content),
                "content": "",
                "source_url": doc.source_uri,
                **edit_ctx,
            })
        if doc.source_uri:
            return RedirectResponse(url=doc.source_uri, status_code=302)

    # Если к документу применялся OCR — показываем ДВА предпросмотра рядом:
    # слева оригинал (PDF/скан), справа извлечённый (распознанный) текст.
    if (doc.extra or {}).get("ocr_applied") and (doc.content or "").strip():
        ext = Path(doc.source_uri).suffix.lower() if doc.source_uri else ""
        return render(request, "document_view.html", {
            "title": doc.title or "Документ",
            "download_url": download_url,
            "mode": "ocr_split",
            "inline_url": f"{download_url}?inline=1",
            "content": doc.content,
            "original_pdf": ext == ".pdf",
            "original_image": ext in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"),
            **edit_ctx,
        })

    ctx = _build_view_ctx(doc.source_uri, doc.title or "Документ", download_url)
    # PDF — чистый нативный просмотр без обёртки приложения
    if ctx.get("mode") == "pdf":
        return RedirectResponse(url=ctx["inline_url"], status_code=302)
    ctx.update(edit_ctx)

    if ctx.get("mode") == "docx" and (doc.content or "").strip():
        ctx["text_url"] = f"/kb/documents/{doc_id}/view?text=1"
        # Тяжёлые docx (гигантские EMF-схемы и т.п.) вешают клиентский рендер,
        # а EMF браузер не отображает вовсе (пустые страницы) — по умолчанию
        # показываем извлечённый текст; оригинал — по явному запросу (?original=1).
        try:
            big = Path(doc.source_uri).stat().st_size > 6 * 1024 * 1024
        except (OSError, TypeError):
            big = False
        if big and not original:
            ctx.update({
                "mode": "text",
                "content": doc.content,
                "text_note": (
                    "Файл большой или содержит элементы, которые браузер не отображает "
                    "(например, EMF-схемы) — показан извлечённый текст."
                ),
                "original_url": f"/kb/documents/{doc_id}/view?original=1",
            })
    return render(request, "document_view.html", ctx)


@router.get("/kb/templates/{template_id}/view", name="page_template_view")
async def template_view(
    request: Request,
    template_id: int,
    user: User = Depends(require_user_redirect),
    db: Session = Depends(get_db),
):
    """Предпросмотр шаблона документа (.docx — через docx-preview, .pdf — нативно)."""
    from data.doc_templates import DocTemplate

    tpl = db.get(DocTemplate, template_id)
    download_url = f"/api/kb/templates/{template_id}/download"
    if not tpl:
        return render(request, "document_view.html",
                      {"title": "Шаблон", "download_url": download_url, "mode": "missing"})
    # Для бланка без переменных показываем версию с подставленными названиями авто-полей.
    from services.documents.generator import template_display_path

    display = str(template_display_path(tpl))
    ctx = _build_view_ctx(display, tpl.title or "Шаблон", download_url)
    if ctx.get("mode") == "pdf":
        return RedirectResponse(url=ctx["inline_url"], status_code=302)
    return render(request, "document_view.html", ctx)


@router.get("/documents/{doc_id}/view", name="page_my_doc_view")
async def my_document_view(
    request: Request,
    doc_id: int,
    user: User = Depends(require_user_redirect),
    db: Session = Depends(get_db),
):
    """Просмотр документа пользователя («Мои документы») — те же режимы."""
    # Документы общие для всех сотрудников — без проверки владельца (по #2).
    doc = db.get(MyDocuments, doc_id)
    download_url = f"/api/documents/{doc_id}/download"
    if not doc:
        return render(request, "document_view.html",
                      {"title": "Документ", "download_url": download_url, "mode": "missing"})
    ctx = _build_view_ctx(doc.file_path, doc.title or "Документ", download_url)
    # PDF — чистый нативный просмотр без обёртки приложения
    if ctx.get("mode") == "pdf":
        return RedirectResponse(url=ctx["inline_url"], status_code=302)
    return render(request, "document_view.html", ctx)


@router.get("/chat/{session_id}", name="page_chat")
async def chat_page(
    request: Request,
    session_id: str,
    user: User = Depends(require_user_redirect),
    db: Session = Depends(get_db),
):
    from data.chat_sessions import ChatSession

    session = db.get(ChatSession, session_id)
    dialogue = session.dialogue if session else None
    if dialogue is None or dialogue.user_id != user.id:
        # доступ запрещён — отдать пустой контекст
        session_id_safe = ""
    else:
        session_id_safe = session_id
    return render(
        request,
        "chat.html",
        {
            "session_id": session_id_safe,
            "dialogue": dialogue,
        },
    )
