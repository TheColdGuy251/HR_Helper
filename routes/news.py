from __future__ import annotations

import re
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import settings
from data.db_session import get_db
from data.news import NewsMedia, NewsPoll, NewsPollOption, NewsPollVote, NewsPost
from data.users import User
from utils.auth_deps import require_kb_editor, require_user
from utils.htmlsanitize import sanitize_html
from utils.logger import logger

router = APIRouter(prefix="/api/news", tags=["news"])

NEWS_DIR = settings.docs_dir / "news"

_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
_FILE_EXT = {
    ".pdf", ".docx", ".doc", ".txt", ".md", ".rst", ".csv",
    ".xlsx", ".xlsm", ".xls", ".pptx", ".ppt", ".rtf", ".odt", ".ods", ".zip",
}


def _unique_path(target_dir: Path, filename: str) -> Path:
    base, ext = Path(filename).stem, Path(filename).suffix
    candidate = target_dir / filename
    i = 1
    while candidate.exists():
        candidate = target_dir / f"{base} ({i}){ext}"
        i += 1
    return candidate


def _author_name(db: Session, author_id: int | None) -> str:
    if not author_id:
        return "—"
    u = db.get(User, author_id)
    return u.full_name if u else "—"


_IMG_SRC_RE = re.compile(r'<img[^>]+src="([^"]+)"', re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")


def _preview(body_html: str) -> tuple[str | None, str]:
    """Первая картинка (для обложки) + текстовая выжимка (для превью в ленте)."""
    m = _IMG_SRC_RE.search(body_html or "")
    img = m.group(1) if m else None
    text = _TAG_RE.sub(" ", body_html or "")
    text = re.sub(r"\s+", " ", text).strip()
    excerpt = text[:200] + ("…" if len(text) > 200 else "")
    return img, excerpt


def _post_dict(db: Session, p: NewsPost, user: User) -> dict:
    preview_image, excerpt = _preview(p.body_html)
    return {
        "id": p.id,
        "title": p.title,
        "body_html": p.body_html,
        "attachments": p.attachments or [],
        "preview_image": preview_image,
        "excerpt": excerpt,
        "poll": _poll_edit_dict(db, p.id),  # для префилла редактора
        "author": _author_name(db, p.author_id),
        "is_pinned": p.is_pinned,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


# ─────────────────────────── чтение (все сотрудники) ───────────────────────────


@router.get("")
async def list_news(user: User = Depends(require_user), db: Session = Depends(get_db)):
    posts = (
        db.query(NewsPost)
        .filter(NewsPost.is_published.is_(True))
        .order_by(NewsPost.is_pinned.desc(), NewsPost.created_at.desc())
        .all()
    )
    return {
        "success": True,
        "can_edit": bool(user.is_admin or user.is_kb_editor),
        "items": [_post_dict(db, p, user) for p in posts],
    }


@router.get("/media/{media_id}")
async def get_media(
    media_id: int,
    download: bool = Query(default=False),
    as_: str | None = Query(default=None, alias="as"),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    m = db.get(NewsMedia, media_id)
    if not m:
        raise HTTPException(404, "Файл не найден")
    path = Path(m.stored_path)
    try:
        path = path.resolve()
        path.relative_to(settings.docs_dir.resolve())
    except (ValueError, OSError):
        raise HTTPException(403, "Доступ к файлу запрещён")
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "Файл отсутствует на диске")
    if as_ == "pdf":
        from utils.file_preview import preview_pdf_response

        resp = preview_pdf_response(path)
        if resp is not None:
            return resp
    # Картинки и pdf показываем прямо в браузере; прочее — по ?download=1 качаем.
    inline = not download
    return FileResponse(
        path,
        filename=m.original_name or path.name,
        media_type=m.mime_type or "application/octet-stream",
        content_disposition_type="inline" if inline else "attachment",
    )


# ─────────────────────── загрузка/создание (редакторы БЗ) ──────────────────────


@router.post("/upload")
async def upload_media(
    file: UploadFile = File(...),
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    """Загрузка картинки или документа для новости. Возвращает media-запись с url —
    редактор вставляет <img> (для картинок) или чип-вложение (для документов)."""
    ext = Path(file.filename or "").suffix.lower()
    is_image = ext in _IMAGE_EXT
    if not (is_image or ext in _FILE_EXT):
        raise HTTPException(400, f"Неподдерживаемый формат: {ext or '—'}")

    NEWS_DIR.mkdir(parents=True, exist_ok=True)
    target = _unique_path(NEWS_DIR, Path(file.filename or "file").name)
    with target.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    size = target.stat().st_size

    m = NewsMedia(
        original_name=Path(file.filename or target.name).name,
        stored_path=str(target),
        mime_type=file.content_type,
        size=size,
        is_image=is_image,
        uploaded_by=user.id,
    )
    db.add(m)
    db.commit()
    db.refresh(m)

    return {
        "success": True,
        "media": {
            "id": m.id,
            "name": m.original_name,
            "size": m.size,
            "is_image": m.is_image,
            "url": f"/api/news/media/{m.id}",
        },
    }


class PollPayload(BaseModel):
    question: str = ""
    description: str | None = None
    allow_multiple: bool = False
    show_voters: bool = False
    options: list[str] = []


class PostPayload(BaseModel):
    title: str = ""
    body_html: str = ""
    attachments: list[dict] | None = None
    is_pinned: bool = False
    poll: PollPayload | None = None


def _save_poll(db: Session, post: NewsPost, pp: PollPayload | None) -> None:
    """Создаёт/заменяет голосование поста. None или <2 вариантов — удаляет.
    Замена сбрасывает прежние голоса (каскадом)."""
    existing = db.query(NewsPoll).filter(NewsPoll.post_id == post.id).first()
    opts = [o.strip() for o in (pp.options if pp else []) if o and o.strip()]
    if not pp or not pp.question.strip() or len(opts) < 2:
        if existing:
            db.delete(existing)
        return
    q = pp.question.strip()[:300]
    desc = (pp.description or "").strip() or None
    trimmed = [o[:300] for o in opts[:12]]
    if existing:
        cur_opts = [
            o.text for o in db.query(NewsPollOption)
            .filter(NewsPollOption.poll_id == existing.id)
            .order_by(NewsPollOption.position).all()
        ]
        unchanged = (
            existing.question == q and existing.description == desc
            and existing.allow_multiple == bool(pp.allow_multiple)
            and existing.show_voters == bool(pp.show_voters)
            and cur_opts == trimmed
        )
        if unchanged:
            return  # опрос не изменился — сохраняем голоса
        db.delete(existing)
        db.flush()
    poll = NewsPoll(
        post_id=post.id, question=q, description=desc,
        allow_multiple=bool(pp.allow_multiple), show_voters=bool(pp.show_voters),
    )
    db.add(poll)
    db.flush()
    for i, text in enumerate(trimmed):
        db.add(NewsPollOption(poll_id=poll.id, text=text, position=i))


def _poll_state(db: Session, poll: NewsPoll, user: User) -> dict:
    options = (
        db.query(NewsPollOption)
        .filter(NewsPollOption.poll_id == poll.id)
        .order_by(NewsPollOption.position)
        .all()
    )
    votes = db.query(NewsPollVote).filter(NewsPollVote.poll_id == poll.id).all()
    by_opt: dict[int, list[int]] = {}
    for v in votes:
        by_opt.setdefault(v.option_id, []).append(v.user_id)
    total = len(votes)
    mine = {v.option_id for v in votes if v.user_id == user.id}

    def voters(uids: list[int]) -> list[dict]:
        if not poll.show_voters:
            return []
        out = []
        for uid in uids:
            u = db.get(User, uid)
            if u:
                out.append({"name": u.full_name, "initials": u.initials})
        return out

    return {
        "id": poll.id,
        "question": poll.question,
        "description": poll.description,
        "allow_multiple": poll.allow_multiple,
        "show_voters": poll.show_voters,
        "total_votes": total,
        "options": [
            {
                "id": o.id,
                "text": o.text,
                "votes": len(by_opt.get(o.id, [])),
                "mine": o.id in mine,
                "voters": voters(by_opt.get(o.id, [])),
            }
            for o in options
        ],
    }


def _poll_edit_dict(db: Session, post_id: int) -> dict | None:
    """Данные голосования для префилла редактора (без счётчиков)."""
    poll = db.query(NewsPoll).filter(NewsPoll.post_id == post_id).first()
    if not poll:
        return None
    opts = (
        db.query(NewsPollOption)
        .filter(NewsPollOption.poll_id == poll.id)
        .order_by(NewsPollOption.position)
        .all()
    )
    return {
        "question": poll.question,
        "description": poll.description or "",
        "allow_multiple": poll.allow_multiple,
        "show_voters": poll.show_voters,
        "options": [o.text for o in opts],
    }


def _resolve_attachments(db: Session, raw: list[dict] | None) -> list[dict]:
    """По списку от клиента берём media_id, перепроверяем существование в БД и
    собираем достоверные метаданные (имя/размер/url с сервера, не с клиента)."""
    out: list[dict] = []
    for item in raw or []:
        mid = item.get("media_id") if isinstance(item, dict) else None
        if not mid:
            continue
        m = db.get(NewsMedia, int(mid))
        if not m:
            continue
        out.append({
            "media_id": m.id,
            "name": m.original_name,
            "size": m.size,
            "is_image": m.is_image,
            "url": f"/api/news/media/{m.id}",
        })
    return out


def _bind_media(db: Session, post: NewsPost) -> None:
    """Привязываем к посту media из вложений и встроенные в текст картинки/документы —
    чтобы при удалении поста файлы удалились каскадом."""
    ids: set[int] = {int(a["media_id"]) for a in (post.attachments or []) if a.get("media_id")}
    ids.update(int(x) for x in re.findall(r"/api/news/media/(\d+)", post.body_html or ""))
    for mid in ids:
        m = db.get(NewsMedia, mid)
        if m and m.post_id is None:
            m.post_id = post.id


@router.post("")
async def create_post(
    payload: PostPayload,
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    title = (payload.title or "").strip()
    body = sanitize_html(payload.body_html or "")
    attachments = _resolve_attachments(db, payload.attachments)
    if not title and not body and not attachments:
        raise HTTPException(400, "Пустая новость")

    post = NewsPost(
        title=title or "Без заголовка",
        body_html=body,
        attachments=attachments or None,
        author_id=user.id,
        is_pinned=bool(payload.is_pinned),
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    _bind_media(db, post)
    _save_poll(db, post, payload.poll)
    db.commit()
    logger.info("[NEWS] пост {} создан пользователем {}", post.id, user.id)
    return {"success": True, "post": _post_dict(db, post, user)}


@router.patch("/{post_id}")
async def update_post(
    post_id: int,
    payload: PostPayload,
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    post = db.get(NewsPost, post_id)
    if not post:
        raise HTTPException(404, "Новость не найдена")
    post.title = (payload.title or "").strip() or "Без заголовка"
    post.body_html = sanitize_html(payload.body_html or "")
    post.attachments = _resolve_attachments(db, payload.attachments) or None
    post.is_pinned = bool(payload.is_pinned)
    post.updated_at = datetime.now()
    _bind_media(db, post)
    _save_poll(db, post, payload.poll)
    db.commit()
    db.refresh(post)
    logger.info("[NEWS] пост {} обновлён пользователем {}", post.id, user.id)
    return {"success": True, "post": _post_dict(db, post, user)}


@router.delete("/{post_id}")
async def delete_post(
    post_id: int,
    user: User = Depends(require_kb_editor),
    db: Session = Depends(get_db),
):
    post = db.get(NewsPost, post_id)
    if not post:
        raise HTTPException(404, "Новость не найдена")
    # Удаляем файлы привязанных media с диска (каскад в БД снесёт записи).
    media = db.query(NewsMedia).filter(NewsMedia.post_id == post_id).all()
    for m in media:
        try:
            p = Path(m.stored_path).resolve()
            p.relative_to(settings.docs_dir.resolve())
            if p.exists():
                p.unlink()
        except (ValueError, OSError):
            pass
    db.delete(post)
    db.commit()
    logger.info("[NEWS] пост {} удалён пользователем {}", post_id, user.id)
    return {"success": True}


# ─────────────────────────── голосование ───────────────────────────


@router.get("/{post_id}/poll")
async def get_poll(
    post_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    poll = db.query(NewsPoll).filter(NewsPoll.post_id == post_id).first()
    if not poll:
        return {"success": True, "poll": None}
    return {"success": True, "poll": _poll_state(db, poll, user)}


class VotePayload(BaseModel):
    option_id: int


@router.post("/poll/vote")
async def vote_poll(
    payload: VotePayload,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    opt = db.get(NewsPollOption, payload.option_id)
    if not opt:
        raise HTTPException(404, "Вариант не найден")
    poll = db.get(NewsPoll, opt.poll_id)
    if not poll:
        raise HTTPException(404, "Голосование не найдено")

    already = (
        db.query(NewsPollVote)
        .filter(
            NewsPollVote.poll_id == poll.id,
            NewsPollVote.option_id == opt.id,
            NewsPollVote.user_id == user.id,
        )
        .first()
    )
    if already:
        db.delete(already)  # повторный клик — снять голос
    else:
        if not poll.allow_multiple:
            # одиночный выбор — снимаем прежние голоса пользователя в этом опросе
            db.query(NewsPollVote).filter(
                NewsPollVote.poll_id == poll.id, NewsPollVote.user_id == user.id
            ).delete()
        db.add(NewsPollVote(poll_id=poll.id, option_id=opt.id, user_id=user.id))
    db.commit()
    return {"success": True, "poll": _poll_state(db, poll, user)}
