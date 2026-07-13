"""Чат между пользователями: личные диалоги, общий чат, поиск по ФИО,
пересылка сообщений ИИ-ассистента с вложениями. Реальное время — через
существующий SSE-хаб (services.notify)."""
from __future__ import annotations

import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import (
    APIRouter, Body, Depends, File, HTTPException, Query, UploadFile,
    WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from config import settings
from data.chat_message import ChatMessage
from data.chat_sessions import ChatSession
from data.db_session import create_session, get_db
from data.my_documents import MyDocuments
from data.user_message import (
    MessengerRead, UserMessage, UserMessageFile, UserMessageReaction,
    Poll, PollOption, PollVote,
)
from data.users import User
from services import notify
from utils.auth_deps import require_user
from utils.logger import logger

router = APIRouter(prefix="/api/messenger", tags=["messenger"])

GENERAL_KEY = "general"

_UPLOAD_DIR = settings.docs_dir / "messenger"
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
_ALLOWED_EXT = _IMAGE_EXT | {
    ".pdf", ".docx", ".doc", ".txt", ".md", ".rtf", ".odt",
    ".xls", ".xlsx", ".ods", ".pptx", ".ppt", ".csv", ".zip",
}


def _serialize_file(f: UserMessageFile) -> dict:
    return {
        "id": f.id,
        "name": f.original_name,
        "size": f.size_bytes,
        "is_image": f.is_image,
        "url": f"/api/messenger/files/{f.id}",
        "download_url": f"/api/messenger/files/{f.id}?download=1",
        "created_at": (f.created_at or datetime.utcnow()).replace(tzinfo=timezone.utc).isoformat(),
        "message_id": f.message_id,
        "w": f.img_w,
        "h": f.img_h,
    }


def _attachments_of(db: Session, message_id: int) -> list[dict]:
    files = db.query(UserMessageFile).filter(UserMessageFile.message_id == message_id).all()
    return [_serialize_file(f) for f in files]


def _reply_preview(db: Session, reply_to_id: Optional[int]) -> Optional[dict]:
    if not reply_to_id:
        return None
    src = db.get(UserMessage, reply_to_id)
    if src is None:
        return None
    sender = db.get(User, src.sender_id)
    sfm = src.forwarded_meta or {}
    if sfm.get("system"):
        text = src.content or ""
    elif sfm and not sfm.get("from_user"):
        text = "Ответ ассистента" if sfm.get("ai") else "↪ сообщение ассистента"
    else:
        text = (src.content or "").replace("\n", " ")
        if not text and db.query(UserMessageFile).filter(UserMessageFile.message_id == src.id).count():
            text = "📎 вложение"
    return {
        "id": src.id,
        "sender_name": sender.short_name if sender else "—",
        "text": text[:80],
    }


# ─────────────────────────── сериализация ───────────────────────────
def _peer_key(msg: UserMessage, viewer_id: int) -> str:
    if msg.is_general:
        return GENERAL_KEY
    return str(msg.recipient_id if msg.sender_id == viewer_id else msg.sender_id)


def _seen_status(db: Session, msg: UserMessage) -> str:
    """Статус доставки/прочтения для СВОЕГО сообщения (для галочек).
    Сравниваем по ВРЕМЕНИ прочтения — устойчиво к переиспользованию rowid."""
    if msg.is_general:
        return "delivered"
    rr = (
        db.query(MessengerRead)
        .filter(MessengerRead.user_id == msg.recipient_id, MessengerRead.peer_key == str(msg.sender_id))
        .first()
    )
    if rr and rr.last_read_at and msg.created_at and rr.last_read_at >= msg.created_at:
        return "seen"
    return "delivered"


def _reactions_of(db: Session, message_id: int, viewer_id: int) -> list[dict]:
    rows = db.query(UserMessageReaction).filter(UserMessageReaction.message_id == message_id).all()
    agg: dict[str, dict] = {}
    for r in rows:
        a = agg.setdefault(r.emoji, {"emoji": r.emoji, "count": 0, "mine": False})
        a["count"] += 1
        if r.user_id == viewer_id:
            a["mine"] = True
    return list(agg.values())


# ─────────────────────────── бот-голосующий ───────────────────────────
# Бот участвует в голосованиях «от своего имени» — как отдельная неактивная
# учётная запись (не попадает в список чатов, т.к. is_active=False).
_BOT_USERNAME = "hr_assistant_bot"
_bot_id_cache: object = "__unset__"


def _bot_user_id(db: Session) -> Optional[int]:
    global _bot_id_cache
    if _bot_id_cache == "__unset__":
        row = db.query(User.id).filter(User.username == _BOT_USERNAME).first()
        _bot_id_cache = row[0] if row else None
    return _bot_id_cache  # type: ignore[return-value]


def _get_bot_user(db: Session) -> User:
    global _bot_id_cache
    bot = db.query(User).filter(User.username == _BOT_USERNAME).first()
    if bot is None:
        bot = User(
            username=_BOT_USERNAME,
            email="assistant@hr.bot.local",
            password_hash="!",  # вход невозможен
            surname="Ассистент", name="HR", patronymic=None,
            position="ИИ-ассистент", sex=None,
            is_active=False, is_admin=False, is_kb_editor=False, can_access_pii=False,
        )
        db.add(bot)
        db.commit()
        db.refresh(bot)
    _bot_id_cache = bot.id
    return bot


def _poll_of(db: Session, message_id: int, viewer_id: int) -> Optional[dict]:
    poll = db.query(Poll).filter(Poll.message_id == message_id).first()
    if poll is None:
        return None
    bot_id = _bot_user_id(db)
    options = db.query(PollOption).filter(PollOption.poll_id == poll.id).order_by(PollOption.position).all()
    votes = db.query(PollVote).filter(PollVote.poll_id == poll.id).all()
    voters_ids = {v.user_id for v in votes}
    by_option: dict[int, list[int]] = {}
    my_options = set()
    for v in votes:
        by_option.setdefault(v.option_id, []).append(v.user_id)
        if v.user_id == viewer_id:
            my_options.add(v.option_id)
    users_map = {}
    if poll.show_voters and voters_ids:
        users_map = {u.id: u for u in db.query(User).filter(User.id.in_(voters_ids)).all()}
    opts = []
    for o in options:
        uids = by_option.get(o.id, [])
        voters = None
        if poll.show_voters:
            voters = [{
                "id": u,
                "name": ("HR-ассистент" if u == bot_id else (users_map[u].full_name if u in users_map else "—")),
                "initials": ("🤖" if u == bot_id else (users_map[u].initials if u in users_map else "?")),
                "sex": (None if u == bot_id else (users_map[u].sex if u in users_map else None)),
                "is_bot": u == bot_id,
            } for u in uids]
        opts.append({
            "id": o.id, "text": o.text, "votes": len(uids), "mine": o.id in my_options, "voters": voters,
        })
    return {
        "id": poll.id,
        "question": poll.question,
        "description": poll.description or "",
        "allow_multiple": poll.allow_multiple,
        "show_voters": poll.show_voters,
        "allow_change": poll.allow_change,
        "allow_bot": bool(getattr(poll, "allow_bot", True)),
        "options": opts,
        "total_votes": len(voters_ids),
        "voted": bool(my_options),
    }


def _serialize(msg: UserMessage, viewer_id: int, sender: User | None, db: Session | None = None) -> dict:
    mine = msg.sender_id == viewer_id
    # Сообщение «Заметок» (диалог с самим собой): sender == recipient. По этому
    # флагу клиент отрисовывает пересланные чужие сообщения слева зелёным пузырём.
    self_chat = (not msg.is_general) and msg.sender_id == msg.recipient_id
    fm = msg.forwarded_meta or {}
    # «forwarded» (ассистентский пузырёк) — только для снимка ответа ИИ, НЕ для
    # системных строк и НЕ для пересланных сообщений пользователей (from_user).
    is_asst_fwd = bool(fm) and not fm.get("system") and not fm.get("from_user")
    return {
        "id": msg.id,
        "sender_id": msg.sender_id,
        "sender_name": sender.short_name if sender else "—",
        "sender_initials": sender.initials if sender else "?",
        "content": msg.content or "",
        "forwarded": is_asst_fwd,
        "forwarded_meta": fm if is_asst_fwd else None,
        "forwarded_from": fm.get("from_user"),
        # created_at хранится наивно в UTC — отдаём с явным UTC-смещением, чтобы
        # клиент парсил его как UTC (иначе Date() трактует как локальное время и
        # ломается группировка/время сообщений).
        "created_at": (msg.created_at or datetime.utcnow()).replace(tzinfo=timezone.utc).isoformat(),
        "mine": mine,
        "self_chat": self_chat,
        "peer_key": _peer_key(msg, viewer_id),
        "is_general": msg.is_general,
        "is_pinned": bool(msg.is_pinned),
        "is_edited": bool(msg.is_edited),
        "is_ai_query": bool(getattr(msg, "is_ai_query", False)),
        "system": bool(msg.forwarded_meta and msg.forwarded_meta.get("system")),
        "reply_to": _reply_preview(db, msg.reply_to_id) if db is not None else None,
        "attachments": _attachments_of(db, msg.id) if db is not None else [],
        "status": (_seen_status(db, msg) if (mine and db is not None) else None),
        "reactions": _reactions_of(db, msg.id, viewer_id) if db is not None else [],
        "poll": _poll_of(db, msg.id, viewer_id) if db is not None else None,
    }


def _thread_filter(user_id: int, peer_id: Optional[int], general: bool):
    if general:
        return UserMessage.is_general.is_(True)
    return and_(
        UserMessage.is_general.is_(False),
        or_(
            and_(UserMessage.sender_id == user_id, UserMessage.recipient_id == peer_id),
            and_(UserMessage.sender_id == peer_id, UserMessage.recipient_id == user_id),
        ),
    )


def _unread_count(db: Session, user_id: int, peer_key: str, flt) -> int:
    row = (
        db.query(MessengerRead)
        .filter(MessengerRead.user_id == user_id, MessengerRead.peer_key == peer_key)
        .first()
    )
    last_read = row.last_read_id if row else 0
    msgs = (
        db.query(UserMessage)
        .filter(flt, UserMessage.id > last_read, UserMessage.sender_id != user_id)
        .all()
    )
    # Системные строки («закрепил(а) сообщение») — не непрочитанные: клиент при
    # live-событиях их тоже не считает, и разделитель «Новые» их пропускает.
    return sum(1 for m in msgs if not ((m.forwarded_meta or {}).get("system")))


def _mark_read(db: Session, user_id: int, peer_key: str, flt) -> None:
    max_id = db.query(UserMessage.id).filter(flt).order_by(UserMessage.id.desc()).limit(1).scalar()
    if max_id is None:
        return
    now = datetime.utcnow()
    row = (
        db.query(MessengerRead)
        .filter(MessengerRead.user_id == user_id, MessengerRead.peer_key == peer_key)
        .first()
    )
    if row is None:
        db.add(MessengerRead(user_id=user_id, peer_key=peer_key, last_read_id=max_id, last_read_at=now))
    else:
        if max_id > row.last_read_id:
            row.last_read_id = max_id
        row.last_read_at = now
    db.commit()
    # Событие САМОМУ читателю: бейдж центра уведомлений (в этой и других вкладках)
    # гаснет мгновенно, а не по фолбэк-поллингу. Собеседнику уходит user_read отдельно.
    notify.publish(user_id, {"type": "unread_changed", "scope": "messenger", "peer_key": peer_key})


# ─────────────────────────── список диалогов ───────────────────────────
@router.get("/conversations")
async def conversations(
    q: str = Query(default=""),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Все пользователи (кроме себя) + общий чат. Поиск по ФИО через q."""
    query = db.query(User).filter(User.id != user.id, User.is_active.is_(True))
    term = (q or "").strip().lower()
    users = query.order_by(User.surname, User.name).all()
    if term:
        users = [
            u for u in users
            if term in (u.full_name or "").lower() or term in (u.username or "").lower()
        ]

    items = []
    for u in users:
        flt = _thread_filter(user.id, u.id, False)
        last = db.query(UserMessage).filter(flt).order_by(UserMessage.id.desc()).first()
        items.append({
            "key": str(u.id),
            "peer_id": u.id,
            "name": u.full_name,
            "short_name": u.short_name,
            "initials": u.initials,
            "position": u.position or "",
            "unread": _unread_count(db, user.id, str(u.id), flt),
            "last_text": _preview(last, user.id, db) if last else "",
            "last_at": last.created_at.isoformat() if last else None,
        })

    # Общий чат — показываем всегда первым, если поиск пуст или совпадает.
    general_item = None
    if not term or term in "общий чат общий":
        gflt = _thread_filter(user.id, None, True)
        glast = db.query(UserMessage).filter(gflt).order_by(UserMessage.id.desc()).first()
        general_item = {
            "key": GENERAL_KEY,
            "peer_id": None,
            "name": "Общий чат",
            "short_name": "Общий чат",
            "initials": "★",
            "position": "Все сотрудники",
            "unread": _unread_count(db, user.id, GENERAL_KEY, gflt),
            "last_text": _preview(glast, user.id, db) if glast else "",
            "last_at": glast.created_at.isoformat() if glast else None,
        }

    # «Заметки» — личный self-чат (диалог с самим собой): заметки + запросы к ИИ.
    # peer_key = собственный id, сообщения имеют sender == recipient == user.id.
    notes_item = None
    if not term or term in "заметки notes мои заметки":
        nflt = _thread_filter(user.id, user.id, False)
        nlast = db.query(UserMessage).filter(nflt).order_by(UserMessage.id.desc()).first()
        notes_item = {
            "key": str(user.id),
            "peer_id": user.id,
            "name": "Заметки",
            "short_name": "Заметки",
            "initials": "📝",
            "position": "Личные заметки и запросы к ИИ",
            "is_notes": True,
            "unread": 0,   # свои заметки непрочитанными не бывают
            "last_text": (_preview(nlast, user.id, db) if nlast else ""),
            "last_at": nlast.created_at.isoformat() if nlast else None,
        }

    return {"general": general_item, "notes": notes_item, "users": items}


def _preview(msg: UserMessage, viewer_id: int, db: Session | None = None) -> str:
    fm = msg.forwarded_meta or {}
    if fm.get("system"):
        return (msg.content or "").replace("\n", " ")
    if fm and not fm.get("from_user"):
        base = "Ответ ассистента" if fm.get("ai") else "↪ пересланное сообщение ассистента"
    else:
        # обычное или пересланное от пользователя — текст, а для вложений — метка.
        base = (msg.content or "").replace("\n", " ")
        if db is not None:
            files = db.query(UserMessageFile).filter(UserMessageFile.message_id == msg.id).all()
            if files:
                imgs = [f for f in files if f.is_image]
                docs = [f for f in files if not f.is_image]
                icon = "🏞️ " if imgs else ("📄 " if docs else "")
                if base:
                    base = icon + base
                elif imgs:
                    base = "🏞️ " + ("Изображение" if len(imgs) == 1 else "Изображения")
                elif docs:
                    base = "📄 " + ("Документ" if len(docs) == 1 else "Документы")
    if len(base) > 60:
        base = base[:60] + "…"
    prefix = "Вы: " if msg.sender_id == viewer_id else ""
    return prefix + base


# ─────────────────────────── история диалога ───────────────────────────
# Постраничная загрузка: сразу отдаём последние 100 сообщений, а дальше —
# партиями по 50 при прокрутке вверх (before_id). Клиент кеширует их в памяти.
_INITIAL_THREAD = 100
_THREAD_PAGE = 50


@router.get("/thread")
async def thread(
    peer_id: Optional[int] = Query(default=None),
    general: bool = Query(default=False),
    before_id: Optional[int] = Query(default=None),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    if not general and not peer_id:
        raise HTTPException(400, "Не указан собеседник")
    if not general and not db.get(User, peer_id):
        raise HTTPException(404, "Пользователь не найден")

    flt = _thread_filter(user.id, peer_id, general)
    q = db.query(UserMessage).filter(flt)
    if before_id:
        # Более старая партия (при прокрутке вверх).
        rows = q.filter(UserMessage.id < before_id).order_by(UserMessage.id.desc()).limit(_THREAD_PAGE).all()
    else:
        # Первый заход: последние 100 сообщений.
        rows = q.order_by(UserMessage.id.desc()).limit(_INITIAL_THREAD).all()
    rows = list(reversed(rows))   # по возрастанию id
    # «удалённые только у себя» — скрываем от этого пользователя
    msgs = [m for m in rows if not (m.hidden_for and user.id in m.hidden_for)]

    # Есть ли ещё более старые сообщения (для подгрузки).
    has_more = False
    if rows:
        oldest = rows[0].id
        has_more = db.query(UserMessage.id).filter(flt, UserMessage.id < oldest).first() is not None

    # имена отправителей (для общего чата их много)
    sender_ids = {m.sender_id for m in msgs}
    senders = {u.id: u for u in db.query(User).filter(User.id.in_(sender_ids)).all()} if sender_ids else {}

    peer_key = GENERAL_KEY if general else str(peer_id)
    # Граница «новых» сообщений (до отметки о прочтении): первое чужое сообщение,
    # которое пользователь ещё не читал. Нужно для разделителя и бейджа на стрелке.
    first_unread_id = None
    unread_count = 0
    if not before_id:
        rr = (
            db.query(MessengerRead)
            .filter(MessengerRead.user_id == user.id, MessengerRead.peer_key == peer_key)
            .first()
        )
        last_read = rr.last_read_id if rr else 0
        unread_msgs = [m for m in msgs if m.id > last_read and m.sender_id != user.id
                       and not (m.forwarded_meta and m.forwarded_meta.get("system"))]
        if unread_msgs:
            first_unread_id = unread_msgs[0].id
            unread_count = len(unread_msgs)

    # Отметку о прочтении ставим только при обычном (первом) открытии, не при подгрузке истории.
    if not before_id:
        _mark_read(db, user.id, peer_key, flt)
        if not general and peer_id and msgs:
            max_id = max(m.id for m in msgs)
            notify.publish(peer_id, {"type": "user_read", "peer_key": str(user.id), "last_read_id": max_id})

    return {
        "peer_key": peer_key,
        "has_more": has_more,
        "first_unread_id": first_unread_id,
        "unread_count": unread_count,
        "messages": [_serialize(m, user.id, senders.get(m.sender_id), db) for m in msgs],
    }


# ─────────────────────────── отправка ───────────────────────────
@router.post("/send")
async def send(
    peer_id: Optional[int] = Body(default=None),
    general: bool = Body(default=False),
    content: str = Body(default=""),
    forward_message_id: Optional[int] = Body(default=None),
    forward_user_message_id: Optional[int] = Body(default=None),
    reply_to_id: Optional[int] = Body(default=None),
    attachment_ids: Optional[List[int]] = Body(default=None),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    content = (content or "").strip()
    forwarded_meta = None
    attachment_ids = attachment_ids or []
    forward_src_id = None                       # для переноса вложений при пересылке

    if forward_message_id is not None:
        # Пересылка сообщения ИИ-ассистента (из чата).
        forwarded_meta = _forward_snapshot(db, forward_message_id)
        if forwarded_meta is None:
            raise HTTPException(404, "Пересылаемое сообщение не найдено")
    elif forward_user_message_id is not None:
        # Пересылка сообщения мессенджера дальше.
        src = db.get(UserMessage, forward_user_message_id)
        if src is None:
            raise HTTPException(404, "Пересылаемое сообщение не найдено")
        forward_src_id = src.id
        sfm = src.forwarded_meta or {}
        if sfm.get("ai") or sfm.get("content"):
            # снимок ответа ассистента — переносим как есть
            forwarded_meta = sfm
        else:
            # обычное сообщение → помечаем, ОТ КОГО переслано (исходный автор).
            if sfm.get("from_user"):
                origin = sfm["from_user"]                    # уже пересланное — сохраняем автора
            else:
                orig_u = db.get(User, src.sender_id)
                origin = {"id": orig_u.id, "name": orig_u.full_name, "initials": orig_u.initials} if orig_u else {"name": "—", "initials": "?"}
            forwarded_meta = {"from_user": origin}
            if not content:
                content = (src.content or "").strip()

    # свои загруженные, ещё не привязанные файлы
    pending_files = [
        f for f in db.query(UserMessageFile).filter(
            UserMessageFile.id.in_(attachment_ids),
            UserMessageFile.owner_id == user.id,
            UserMessageFile.message_id.is_(None),
        ).all()
    ] if attachment_ids else []

    if not content and forwarded_meta is None and not pending_files:
        raise HTTPException(400, "Пустое сообщение")

    if not general:
        if not peer_id or not db.get(User, peer_id):
            raise HTTPException(404, "Получатель не найден")
        # peer_id == user.id — это «Заметки» (диалог с собой), разрешено.

    msg = UserMessage(
        sender_id=user.id,
        recipient_id=None if general else peer_id,
        is_general=general,
        content=content,
        forwarded_meta=forwarded_meta,
        reply_to_id=reply_to_id if reply_to_id and db.get(UserMessage, reply_to_id) else None,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    for f in pending_files:
        f.message_id = msg.id
    if pending_files:
        db.commit()

    # Пересылка вложений: дублируем файлы исходного сообщения (копии на диске).
    if forward_src_id is not None:
        _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        src_files = db.query(UserMessageFile).filter(UserMessageFile.message_id == forward_src_id).all()
        copied = False
        for sf in src_files:
            try:
                src_path = Path(sf.stored_path)
                if not src_path.exists():
                    continue
                new_path = _UPLOAD_DIR / f"{uuid.uuid4().hex}{src_path.suffix.lower()}"
                shutil.copyfile(src_path, new_path)
                db.add(UserMessageFile(
                    message_id=msg.id, owner_id=user.id, original_name=sf.original_name,
                    stored_path=str(new_path), content_type=sf.content_type,
                    size_bytes=sf.size_bytes, is_image=sf.is_image,
                    img_w=sf.img_w, img_h=sf.img_h,
                ))
                copied = True
            except OSError:
                pass
        if copied:
            db.commit()

    # Отправитель сразу считает своё сообщение прочитанным в этом диалоге.
    flt = _thread_filter(user.id, peer_id, general)
    _mark_read(db, user.id, GENERAL_KEY if general else str(peer_id), flt)

    _broadcast(db, msg, user)
    return _serialize(msg, user.id, user, db)


def _publish_typing(db: Session, user: User, peer_id: int | None, general: bool, is_typing: bool) -> None:
    """Рассылает сигнал «печатает» собеседнику(ам) по SSE (не сохраняется)."""
    if general:
        recipients = [uid for (uid,) in db.query(User.id).filter(User.is_active.is_(True)).all() if uid != user.id]
    else:
        if not peer_id or not db.get(User, peer_id):
            return
        recipients = [peer_id]
    for uid in set(recipients):
        notify.publish(uid, {
            "type": "user_typing",
            # peer_key с точки зрения получателя: 1-1 → id отправителя, общий → general
            "peer_key": GENERAL_KEY if general else str(user.id),
            "sender_id": user.id,
            "sender_name": user.short_name,
            "sender_initials": user.initials,
            "is_general": general,
            "typing": bool(is_typing),
        })


def _do_read(db: Session, user_id: int, peer_id: int | None, general: bool) -> None:
    """Отметка «диалог прочитан» + user_read собеседнику (двойные галочки)."""
    if not general and (not peer_id or not db.get(User, peer_id)):
        return
    flt = _thread_filter(user_id, peer_id, general)
    _mark_read(db, user_id, GENERAL_KEY if general else str(peer_id), flt)
    if not general and peer_id:
        max_id = db.query(func.max(UserMessage.id)).filter(flt).scalar()
        if max_id:
            notify.publish(peer_id, {
                "type": "user_read", "peer_key": str(user_id), "last_read_id": max_id,
            })


@router.post("/typing")
async def typing(
    peer_id: Optional[int] = Body(default=None),
    general: bool = Body(default=False),
    typing: bool = Body(default=True),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """HTTP-фолбэк сигнала «печатает» (основной канал — WebSocket /api/messenger/ws)."""
    if not general and (not peer_id or not db.get(User, peer_id)):
        raise HTTPException(404, "Получатель не найден")
    _publish_typing(db, user, peer_id, general, bool(typing))
    return {"ok": True}


@router.post("/read")
async def mark_thread_read(
    peer_id: Optional[int] = Body(default=None),
    general: bool = Body(default=False),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Лёгкая отметка прочтения диалога (HTTP-фолбэк WS-сигнала). Раньше клиент
    для этого перезапрашивал ВЕСЬ тред и выбрасывал ответ."""
    _do_read(db, user.id, peer_id, general)
    return {"ok": True}


@router.websocket("/ws")
async def messenger_ws(websocket: WebSocket):
    """WebSocket для ВЫСОКОЧАСТОТНЫХ сигналов клиент→сервер: «печатает» и отметки
    прочтения. Такие сигналы дёшевы и часты — гонять их отдельными HTTP-запросами
    расточительно. Канал сервер→клиент остаётся на SSE (/api/events): доставка
    редких событий, авто-reconnect из коробки. Формат сообщений:
      {"type": "typing", "peer_id": N | "general": true, "typing": true|false}
      {"type": "read",   "peer_id": N | "general": true}
    """
    user_id = None
    try:
        user_id = websocket.session.get("user_id")
    except Exception:
        pass
    if not user_id:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            mtype = data.get("type")
            general = bool(data.get("general"))
            peer_id = data.get("peer_id")
            s = create_session()
            try:
                user = s.get(User, user_id)
                if user is None:
                    break
                if mtype == "typing":
                    _publish_typing(s, user, peer_id, general, bool(data.get("typing", True)))
                elif mtype == "read":
                    _do_read(s, user_id, peer_id, general)
            finally:
                s.close()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("[WS] соединение сигналов закрыто с ошибкой: {}", e)


@router.get("/attachments")
async def list_attachments(
    peer_id: Optional[int] = Query(default=None),
    general: bool = Query(default=False),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Все вложения диалога: медиа (картинки), документы, ссылки — для модалки."""
    flt = _thread_filter(user.id, peer_id, general)
    msgs = db.query(UserMessage).filter(flt).order_by(UserMessage.id.desc()).all()
    msgs = [m for m in msgs if not (m.hidden_for and user.id in m.hidden_for)]
    ids = [m.id for m in msgs]
    files = (
        db.query(UserMessageFile).filter(UserMessageFile.message_id.in_(ids)).order_by(UserMessageFile.id.desc()).all()
        if ids else []
    )
    media = [_serialize_file(f) for f in files if f.is_image]
    docs = [_serialize_file(f) for f in files if not f.is_image]
    link_re = re.compile(r"https?://[^\s<>\"']+")
    links: list[dict] = []
    seen: set[str] = set()
    for m in msgs:
        text = m.content or ""
        if m.forwarded_meta and m.forwarded_meta.get("content"):
            text += " " + m.forwarded_meta["content"]
        for url in link_re.findall(text):
            u = url.rstrip(".,);")
            if u not in seen:
                seen.add(u)
                links.append({"url": u, "message_id": m.id})
    return {"media": media, "documents": docs, "links": links}


@router.get("/presence")
async def presence(
    peer_id: int = Query(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Онлайн-статус собеседника: online + момент последнего появления."""
    ls = notify.last_seen(peer_id)
    return {
        "online": notify.is_online(peer_id),
        "last_seen": ls.isoformat() if ls else None,
    }


def _forward_snapshot(db: Session, chat_message_id: int) -> Optional[dict]:
    """Снимок сообщения ИИ-ассистента (текст + вложение + источники)."""
    cm = db.get(ChatMessage, chat_message_id)
    if cm is None:
        return None
    attachment = None
    if cm.attachment_document_id:
        doc = db.get(MyDocuments, cm.attachment_document_id)
        if doc:
            attachment = {
                "id": doc.id,
                "title": doc.title or "Документ",
                "filename": (doc.file_path.rsplit("\\", 1)[-1].rsplit("/", 1)[-1]) if doc.file_path else "",
            }
    return {
        "content": cm.content or "",
        "attachment": attachment,
        "sources": cm.sources or [],
    }


def _recipients_of(db: Session, msg: UserMessage) -> list[int]:
    if msg.is_general:
        return [uid for (uid,) in db.query(User.id).filter(User.is_active.is_(True)).all()]
    return [uid for uid in (msg.recipient_id, msg.sender_id) if uid is not None]


def _broadcast(db: Session, msg: UserMessage, sender: User) -> None:
    """Доставка события подписчикам SSE. Для общего чата — всем пользователям.
    Плюс системный Web Push получателям (кроме автора) — уведомление приходит,
    даже если вкладка/приложение закрыты."""
    from services import push

    is_system = bool((msg.forwarded_meta or {}).get("system"))
    for uid in set(_recipients_of(db, msg)):
        payload = _serialize(msg, uid, sender, db)
        notify.publish(uid, {"type": "user_message", "message": payload})
        # Push — только чужим получателям и не для служебных строк.
        if uid != msg.sender_id and not is_system:
            title = "Общий чат" if msg.is_general else (sender.short_name if sender else "Новое сообщение")
            body = _preview(msg, uid, db)
            if msg.is_general and sender:
                body = f"{sender.short_name}: {body}"
            push.notify_user(uid, {
                "title": title, "body": (body or "Новое сообщение")[:120],
                "url": "/messenger", "tag": "msgr-" + _pk_for(msg, uid),
            })


# ─────────────────────────── вложения ───────────────────────────
@router.post("/upload")
async def upload(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(400, f"Неподдерживаемый формат: {ext or '—'}")
    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stored = _UPLOAD_DIR / f"{uuid.uuid4().hex}{ext}"
    # Лимит проверяем ПО МЕРЕ записи — иначе на диск успевает лечь файл любого размера.
    size = 0
    try:
        with open(stored, "wb") as fp:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > _MAX_UPLOAD_BYTES:
                    raise HTTPException(400, "Файл больше 20 МБ")
                fp.write(chunk)
    except HTTPException:
        stored.unlink(missing_ok=True)
        raise

    is_image = ext in _IMAGE_EXT
    img_w = img_h = None
    if is_image:
        try:
            from PIL import Image
            with Image.open(stored) as im:
                img_w, img_h = im.size
        except Exception:
            img_w = img_h = None
    rec = UserMessageFile(
        owner_id=user.id,
        original_name=file.filename or stored.name,
        stored_path=str(stored),
        content_type=file.content_type,
        size_bytes=size,
        is_image=is_image,
        img_w=img_w,
        img_h=img_h,
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return _serialize_file(rec)


_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/csv",
}


@router.get("/files/{file_id}")
async def get_file(
    file_id: int,
    download: bool = Query(default=False),
    as_: str | None = Query(default=None, alias="as"),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    rec = db.get(UserMessageFile, file_id)
    if not rec or not Path(rec.stored_path).exists():
        raise HTTPException(404, "Файл не найден")
    # Доступ: владелец файла или участник диалога сообщения (404, чтобы не
    # раскрывать существование чужих файлов перебором id).
    if rec.owner_id != user.id:
        msg = db.get(UserMessage, rec.message_id) if rec.message_id else None
        if not msg or (not msg.is_general and user.id not in (msg.sender_id, msg.recipient_id)):
            raise HTTPException(404, "Файл не найден")
    if as_ == "pdf":
        from utils.file_preview import preview_pdf_response

        resp = preview_pdf_response(rec.stored_path)
        if resp is not None:
            return resp
    ext = Path(rec.stored_path).suffix.lower()
    media = _MIME.get(ext, "application/octet-stream")
    return FileResponse(
        rec.stored_path,
        filename=rec.original_name,
        media_type=media,
        content_disposition_type="attachment" if download else "inline",
    )


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: int,
    for_all: bool = Query(default=False),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    msg = db.get(UserMessage, message_id)
    if not msg:
        raise HTTPException(404, "Сообщение не найдено")
    is_participant = msg.is_general or user.id in (msg.sender_id, msg.recipient_id)
    if not is_participant:
        raise HTTPException(403, "Нет доступа")

    if not for_all:
        # «Удалить у себя» — можно для любого сообщения диалога (в т.ч. чужого).
        hidden = list(msg.hidden_for or [])
        if user.id not in hidden:
            hidden.append(user.id)
            msg.hidden_for = hidden
            db.commit()
        return {"ok": True, "for_all": False}

    # Системные отметки удаляются только у себя.
    if msg.forwarded_meta and msg.forwarded_meta.get("system"):
        raise HTTPException(403, "Системное сообщение можно удалить только у себя")
    # «Удалить для всех» — только своё сообщение.
    if msg.sender_id != user.id:
        raise HTTPException(403, "Для всех можно удалять только свои сообщения")

    peer_key_map = {uid: (GENERAL_KEY if msg.is_general else str(msg.sender_id if uid != msg.sender_id else msg.recipient_id))
                    for uid in _recipients_of(db, msg)}
    for f in db.query(UserMessageFile).filter(UserMessageFile.message_id == msg.id).all():
        try:
            p = Path(f.stored_path).resolve()
            p.relative_to(_UPLOAD_DIR.resolve())
            p.unlink(missing_ok=True)
        except (ValueError, OSError):
            pass
    db.delete(msg)
    db.commit()
    for uid, pk in peer_key_map.items():
        notify.publish(uid, {"type": "user_message_deleted", "id": message_id, "peer_key": pk})
    return {"ok": True, "for_all": True}


@router.post("/pin")
async def pin_message(
    message_id: int = Body(...),
    pinned: bool = Body(default=True),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    msg = db.get(UserMessage, message_id)
    if not msg:
        raise HTTPException(404, "Сообщение не найдено")
    if not msg.is_general and user.id not in (msg.sender_id, msg.recipient_id):
        raise HTTPException(403, "Нет доступа")

    # Peer с точки зрения ЗАКРЕПЛЯЮЩЕГО: закреплять можно и чужое сообщение,
    # тогда собеседник — его отправитель (а не recipient_id == сам пользователь).
    peer_of_user = None if msg.is_general else (
        msg.sender_id if msg.sender_id != user.id else msg.recipient_id
    )
    flt = _thread_filter(user.id, peer_of_user, msg.is_general)
    unpinned_ids: list[int] = []
    if pinned:
        # В диалоге закреплено только ОДНО сообщение — снимаем закрепление с прочих.
        for other in db.query(UserMessage).filter(flt, UserMessage.is_pinned.is_(True), UserMessage.id != msg.id).all():
            other.is_pinned = False
            unpinned_ids.append(other.id)
    msg.is_pinned = bool(pinned)
    db.flush()

    # Системная (серая) отметка о закреплении/откреплении — её можно удалить.
    # Получатель — собеседник (НЕ msg.recipient_id: при закреплении чужого сообщения
    # им оказался бы сам закрепляющий, и отметка не попала бы в диалог).
    sys_recipient = None if msg.is_general else (
        msg.sender_id if user.id != msg.sender_id else msg.recipient_id
    )
    system_msg = UserMessage(
        sender_id=user.id, recipient_id=sys_recipient, is_general=msg.is_general,
        content=("закрепил(а) сообщение" if pinned else "открепил(а) сообщение"),
        forwarded_meta={"system": True},
    )
    db.add(system_msg)
    db.commit()

    for uid in set(_recipients_of(db, msg)):
        pk = GENERAL_KEY if msg.is_general else str(msg.sender_id if uid != msg.sender_id else msg.recipient_id)
        for uid2 in unpinned_ids:
            notify.publish(uid, {"type": "user_message_pinned", "id": uid2, "pinned": False, "peer_key": pk})
        notify.publish(uid, {"type": "user_message_pinned", "id": message_id, "pinned": msg.is_pinned, "peer_key": pk})
    if system_msg:
        db.refresh(system_msg)
        _broadcast(db, system_msg, user)
    return {"ok": True, "pinned": msg.is_pinned}


@router.post("/edit")
async def edit_message(
    message_id: int = Body(...),
    content: str = Body(default=""),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    msg = db.get(UserMessage, message_id)
    if not msg:
        raise HTTPException(404, "Сообщение не найдено")
    if msg.sender_id != user.id:
        raise HTTPException(403, "Можно редактировать только свои сообщения")
    if msg.forwarded_meta:
        raise HTTPException(400, "Пересланное сообщение нельзя редактировать")
    content = (content or "").strip()
    if not content:
        raise HTTPException(400, "Пустое сообщение")
    msg.content = content
    msg.is_edited = True
    db.commit()
    for uid in set(_recipients_of(db, msg)):
        pk = GENERAL_KEY if msg.is_general else str(msg.sender_id if uid != msg.sender_id else msg.recipient_id)
        notify.publish(uid, {"type": "user_message_edited", "id": message_id, "content": content, "peer_key": pk})
    return {"ok": True, "content": content}


def _pk_for(msg: UserMessage, uid: int) -> str:
    return GENERAL_KEY if msg.is_general else str(msg.sender_id if uid != msg.sender_id else msg.recipient_id)


# ─────────────────────────── вопрос ИИ в диалоге ───────────────────────────
# Мета-вопросы о САМОЙ переписке («что происходило в чате», «о чём мы говорили»,
# «перескажи переписку»). Их нельзя гнать через RAG: поиск по такой фразе находит
# случайные документы базы знаний, и модель пересказывает ИХ вместо истории чата
# (галлюцинация вида «вы обсуждали аттестацию»). Ответ — только по истории.
_CHAT_META_RE = re.compile(
    r"(о\s*ч[её]м|про\s*что)\s+(эт(от|а|о)\s+)?(чат|диалог|разговор|беседа|переписк|"
    r"мы\s+(тут\s+|здесь\s+)?(говор|обща|переписыва))"
    r"|что\s+(тут\s+|здесь\s+|у\s+нас\s+)?(происходил|обсуждал|обсужда|писал)"
    r"|(перескаж|резюмируй|суммируй|подытож|подведи\s+итог|краткое\s+содержани)"
    r".{0,40}(чат|диалог|переписк|разговор|бесед|сообщени)"
    r"|о\s*ч[её]м\s+(шла\s+)?речь",
    re.IGNORECASE,
)


def _history_for(db: Session, flt, before_id: int, limit: int = 5) -> list[dict]:
    """Контекст последних сообщений (текст + вложения/голосования/реакции).
    Сообщения пользователей помечаются именем отправителя — иначе модель не знает,
    кто что писал, и не может отвечать на вопросы о переписке."""
    msgs = (
        db.query(UserMessage).filter(flt, UserMessage.id < before_id)
        .order_by(UserMessage.id.desc()).limit(limit).all()
    )
    hist: list[dict] = []
    senders: dict[int, User | None] = {}
    for m in reversed(msgs):
        fm = m.forwarded_meta or {}
        if fm.get("system"):
            continue  # «закрепил(а) сообщение» и т.п. — шум для модели
        is_ai = bool(fm.get("ai"))
        role = "assistant" if is_ai else "user"
        text = (fm.get("content", "") if fm else "") or m.content or ""
        # Пересланный снимок ответа ассистента (из /chat) — помечаем происхождение,
        # чтобы модель не приписывала свой текст пересылающему сотруднику.
        if fm and not is_ai and fm.get("content"):
            text = f"(переслан ответ ИИ-ассистента) {text}"
        elif fm.get("from_user"):
            origin = (fm.get("from_user") or {}).get("name") or "другого сотрудника"
            text = f"(переслано от {origin}) {text}"
        extras: list[str] = []
        files = db.query(UserMessageFile).filter(UserMessageFile.message_id == m.id).all()
        if files:
            extras.append("вложения: " + ", ".join(f.original_name for f in files))
        poll = db.query(Poll).filter(Poll.message_id == m.id).first()
        if poll:
            # Варианты + ТЕКУЩИЕ РЕЗУЛЬТАТЫ — модель может рассуждать об итогах
            # («какой вариант победил», «сколько проголосовало»).
            popts = db.query(PollOption).filter(PollOption.poll_id == poll.id).order_by(PollOption.position).all()
            votes = db.query(PollVote).filter(PollVote.poll_id == poll.id).all()
            per_opt: dict[int, int] = {}
            for v in votes:
                per_opt[v.option_id] = per_opt.get(v.option_id, 0) + 1
            total_voters = len({v.user_id for v in votes})
            opts_desc = "; ".join(
                f"«{o.text}» — {per_opt.get(o.id, 0)} голос(ов)" for o in popts
            )
            extras.append(
                f"голосование «{poll.question}»: {opts_desc} (проголосовало: {total_voters})"
            )
        reacts = db.query(UserMessageReaction).filter(UserMessageReaction.message_id == m.id).all()
        if reacts:
            extras.append("реакции: " + " ".join(r.emoji for r in reacts))
        if extras:
            text = (text + " [" + "; ".join(extras) + "]").strip()
        if not text:
            continue
        if not is_ai:
            if m.sender_id not in senders:
                senders[m.sender_id] = db.get(User, m.sender_id)
            u = senders[m.sender_id]
            # Полное ФИО (а не «Фамилия И.») — чтобы модель точно знала, кто автор.
            name = (u.full_name if u else None) or "Сотрудник"
            text = f"[{name}]: {text}"
        hist.append({"role": role, "content": text})
    return hist


@router.post("/ask")
async def ask_ai(
    peer_id: Optional[int] = Body(default=None),
    general: bool = Body(default=False),
    content: str = Body(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    content = (content or "").strip()
    if not content:
        raise HTTPException(400, "Пустой вопрос")
    if not general:
        if not peer_id or not db.get(User, peer_id):
            raise HTTPException(404, "Получатель не найден")
        # peer_id == user.id — запрос к ИИ внутри «Заметок» (диалог с собой).

    # 1) вопрос — обычное сообщение, помеченное как запрос к ассистенту
    q = UserMessage(sender_id=user.id, recipient_id=None if general else peer_id, is_general=general,
                    content=content, is_ai_query=True)
    db.add(q)
    db.commit()
    db.refresh(q)
    flt = _thread_filter(user.id, peer_id, general)
    _mark_read(db, user.id, GENERAL_KEY if general else str(peer_id), flt)
    _broadcast(db, q, user)

    # 2) плейсхолдер ответа ИИ (автор = спросивший, чтобы был на его стороне)
    ai = UserMessage(sender_id=user.id, recipient_id=None if general else peer_id, is_general=general,
                     content="", forwarded_meta={"content": "", "sources": [], "ai": True})
    db.add(ai)
    db.commit()
    db.refresh(ai)
    ai_id = ai.id

    # Мета-вопрос о самой переписке → отвечаем по истории (без поиска по базе
    # знаний) и берём больше сообщений, чтобы было что пересказывать.
    # Детект: регэксп + контекстный классификатор (ловит перефразировки).
    from services.rag.intent_classifier import resolve_intent

    history = _history_for(db, flt, q.id, limit=5)
    is_meta = bool(_CHAT_META_RE.search(content)) or resolve_intent(content, history) == "meta_chat"
    if is_meta:
        history = _history_for(db, flt, q.id, limit=30)
    recipients = list({uid for uid in _recipients_of(db, ai)})
    pk_map = {uid: _pk_for(ai, uid) for uid in recipients}
    asker = user.id

    # Голосование по просьбе: пользователь просит бота проголосовать в опросе.
    # 'reason' — бот высказывает мнение и голосует; 'random' — случайный выбор.
    vote = None
    vote_mode = _detect_vote_intent(content)
    if vote_mode:
        vt = _last_poll_in_thread(db, flt)
        if vt and getattr(vt[1], "allow_bot", True):
            pmsg, vpoll, vopts = vt
            import random as _random
            vote = {
                "mode": vote_mode, "poll_id": vpoll.id, "msg_id": pmsg.id,
                "option_ids": [o.id for o in vopts], "texts": [o.text for o in vopts],
                "question": vpoll.question,
                "chosen_idx": _random.randrange(len(vopts)) if vote_mode == "random" else None,
            }

    # Контекст о чате и участниках — чтобы модель знала, где и с кем общается.
    asker_desc = user.full_name + (f", должность: {user.position}" if user.position else "")
    if general:
        where = "Это общий рабочий чат отдела кадров ТИУ со всеми сотрудниками."
    elif peer_id == user.id:
        where = "Это личные «Заметки» сотрудника (диалог с самим собой): черновики, напоминания и вопросы к ИИ."
    else:
        other = db.get(User, peer_id)
        where = "Это личный чат между {} ({}) и {} ({}).".format(
            user.full_name, user.position or "должность не указана",
            (other.full_name if other else "собеседник"), (other.position if other and other.position else "должность не указана"),
        )
    extra_context = (
        "Ты — ИИ-ассистент отдела кадров ТИУ и сейчас отвечаешь ВНУТРИ переписки между сотрудниками. "
        + where + f" Вопрос задал {asker_desc}. "
        "Учитывай контекст предыдущих сообщений диалога (они в истории) — отвечай в том числе на "
        "вопросы о самой беседе («о чём речь», «что обсуждали»), об участниках и о вложениях/голосованиях. "
        "ВАЖНО: не приписывай участникам качеств, заслуг, опыта или оценок, которых нет в переписке или "
        "базе знаний, и не делай необоснованных выводов о людях. Если фактов недостаточно — так и скажи, "
        "а не выдумывай их."
    )
    if is_meta:
        extra_context += (
            " ВАЖНО: текущий вопрос — о САМОЙ переписке. Отвечай ТОЛЬКО по сообщениям из истории "
            "диалога (имена отправителей указаны в квадратных скобках). Не привлекай нормативные "
            "документы и не выдумывай темы, которых в сообщениях нет. Если переписка неформальная "
            "(приветствия, картинки, шутки) — так и скажи."
        )
    if vote:
        numbered = "\n".join(f"{i + 1}) {t}" for i, t in enumerate(vote["texts"]))
        if vote["mode"] == "random":
            picked = vote["texts"][vote["chosen_idx"]]
            extra_context += (
                f" СЕЙЧАС пользователь просит тебя проголосовать в опросе «{vote['question']}» "
                f"СЛУЧАЙНЫМ образом. Варианты:\n{numbered}\n"
                f"Система засчитает твой голос за вариант «{picked}» — коротко подтверди это, "
                "без разбора вариантов и рассуждений."
            )
        else:
            extra_context += (
                f" СЕЙЧАС пользователь просит тебя проголосовать в опросе «{vote['question']}» "
                f"и высказать своё мнение. Варианты:\n{numbered}\n"
                "Своё мнение основывай ТОЛЬКО на фактах из этой переписки и базы знаний. НЕ придумывай "
                "личные качества, опыт, заслуги или характеристики участников — если в диалоге их нет, "
                "не упоминай их. Если объективных оснований для выбора нет, честно скажи об этом и выбирай "
                "наиболее осторожный/нейтральный вариант. "
                "В САМОМ КОНЦЕ ответа добавь ОТДЕЛЬНОЙ последней строкой строго «ГОЛОС: N», "
                "где N — номер выбранного варианта (только число). Эта строка служебная, "
                "пользователю не показывается."
            )

    def _publish(extra: dict) -> None:
        for uid in recipients:
            notify.publish(uid, dict(extra, type="ai_stream", id=ai_id, peer_key=pk_map[uid], asker_id=asker))

    _publish({"phase": "start", "status": "search"})

    def _worker() -> None:
        from data.db_session import create_session
        from services.rag.pipeline import get_pipeline
        s = create_session()
        acc, srcs = "", []
        try:
            result = get_pipeline().answer_stream(
                content, history=history, use_rag=(not is_meta) and not vote,
                on_status=lambda st: _publish({"phase": "status", "status": st}),
                extra_context=extra_context, allow_no_context_answer=True,
                intent_hint="meta_chat" if is_meta else None,
            )
            srcs = result.sources or []
            _publish({"phase": "sources", "sources": srcs})
            for chunk in result.answer_stream:
                acc += chunk
                _publish({"phase": "chunk", "chunk": chunk})
        except Exception as e:  # noqa: BLE001
            if not acc:
                acc = "Не удалось сформировать ответ: " + str(e)
        # Голос бота (по просьбе в чате): засчитываем ПОСЛЕ ответа.
        if vote:
            _apply_bot_vote(vote, acc)
        # Служебную строку голосования вырезаем ВСЕГДА — даже если запрос не был
        # про голосование: модель иногда имитирует её из контекста прошлых сообщений.
        # Иначе она попадает в чат и в историю, и имитация усиливается.
        display = _strip_vote_marker(acc)
        try:
            m = s.get(UserMessage, ai_id)
            if m:
                m.forwarded_meta = {"content": display, "sources": srcs, "ai": True}
                s.commit()
        finally:
            s.close()
        _publish({"phase": "done", "content": display, "sources": srcs})

    threading.Thread(target=_worker, daemon=True).start()
    return {"question": _serialize(q, user.id, user, db), "ai_message_id": ai_id}


# ─────────────────────── пересылка ассистенту ───────────────────────
@router.post("/forward-to-assistant")
async def forward_to_assistant(
    message_ids: List[int] = Body(..., embed=True),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Пересылает выбранные сообщения в НОВЫЙ диалог с ИИ-ассистентом (/chat).

    Снимок сообщений (кто, из какого чата, когда, текст, вложения) кладётся в
    dialogue.pending_forward: страница чата отрисует его как пересланный блок,
    а при первой отправке он попадёт в контекст модели (см. routes/chat.py)."""
    from data.dialogues import Dialogue

    ids = [int(i) for i in (message_ids or []) if i][:30]
    if not ids:
        raise HTTPException(400, "Не выбраны сообщения")

    msgs = (
        db.query(UserMessage)
        .filter(UserMessage.id.in_(ids))
        .order_by(UserMessage.id.asc())
        .all()
    )
    users_cache: dict[int, User | None] = {}

    def _user(uid: int | None) -> User | None:
        if uid is None:
            return None
        if uid not in users_cache:
            users_cache[uid] = db.get(User, uid)
        return users_cache[uid]

    items: list[dict] = []
    for m in msgs:
        # Только сообщения из диалогов, где пересылающий — участник.
        if not m.is_general and user.id not in (m.sender_id, m.recipient_id):
            continue
        fm = m.forwarded_meta or {}
        if fm.get("system"):
            continue
        sender = _user(m.sender_id)
        if m.is_general:
            chat_label = "Общий чат"
        else:
            peer = _user(m.recipient_id if m.sender_id == user.id else m.sender_id)
            chat_label = f"личный чат с {peer.short_name}" if peer else "личный чат"
        files = db.query(UserMessageFile).filter(UserMessageFile.message_id == m.id).all()
        items.append({
            "from_name": ("HR-ассистент" if fm.get("ai") else (sender.short_name if sender else "—")),
            "from_initials": sender.initials if sender else "?",
            "chat": chat_label,
            "sent_at": (m.created_at or datetime.utcnow()).replace(tzinfo=timezone.utc).isoformat(),
            "text": (fm.get("content") or "") or (m.content or ""),
            "ai": bool(fm.get("ai")),
            "attachments": [
                {
                    "id": f.id,
                    "name": f.original_name,
                    "is_image": f.is_image,
                    "url": f"/api/messenger/files/{f.id}",
                    "w": f.img_w,
                    "h": f.img_h,
                }
                for f in files
            ],
        })
    if not items:
        raise HTTPException(400, "Нет доступных для пересылки сообщений")

    # Заголовок = DEFAULT_TITLE, чтобы авто-название после первого ответа сработало.
    from routes.dialogues import DEFAULT_TITLE

    dlg = Dialogue(user_id=user.id, title=DEFAULT_TITLE, pending_forward=items)
    db.add(dlg)
    db.flush()
    sess = ChatSession(dialogue_id=dlg.id)
    db.add(sess)
    db.commit()
    db.refresh(sess)
    return {"success": True, "dialogue_id": dlg.id, "session_id": sess.id}


# ─────────────────────────── реакции ───────────────────────────
@router.post("/reaction")
async def react(
    message_id: int = Body(...),
    emoji: str = Body(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    msg = db.get(UserMessage, message_id)
    if not msg:
        raise HTTPException(404, "Сообщение не найдено")
    if not msg.is_general and user.id not in (msg.sender_id, msg.recipient_id):
        raise HTTPException(403, "Нет доступа")
    existing = (
        db.query(UserMessageReaction)
        .filter(UserMessageReaction.message_id == message_id, UserMessageReaction.user_id == user.id)
        .first()
    )
    if existing and existing.emoji == emoji:
        db.delete(existing)                 # повторный клик — снять реакцию
    elif existing:
        existing.emoji = emoji              # заменить
    else:
        db.add(UserMessageReaction(message_id=message_id, user_id=user.id, emoji=emoji))
    db.commit()
    for uid in set(_recipients_of(db, msg)):
        notify.publish(uid, {"type": "reaction_updated", "id": message_id,
                             "reactions": _reactions_of(db, message_id, uid), "peer_key": _pk_for(msg, uid)})
    return {"ok": True, "reactions": _reactions_of(db, message_id, user.id)}


# ─────────────────────────── голосования ───────────────────────────
@router.post("/poll")
async def create_poll(
    peer_id: Optional[int] = Body(default=None),
    general: bool = Body(default=False),
    question: str = Body(...),
    description: str = Body(default=""),
    options: List[str] = Body(...),
    allow_multiple: bool = Body(default=False),
    show_voters: bool = Body(default=False),
    allow_change: bool = Body(default=True),
    allow_bot: bool = Body(default=True),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    question = (question or "").strip()
    opts = [o.strip() for o in (options or []) if o and o.strip()][:10]
    if not question:
        raise HTTPException(400, "Укажите вопрос голосования")
    if len(opts) < 2:
        raise HTTPException(400, "Нужно минимум 2 варианта")

    # число участников диалога должно быть > 2
    if general:
        participants = db.query(User).filter(User.is_active.is_(True)).count()
    else:
        participants = 2
    if participants <= 2:
        raise HTTPException(400, "Голосование доступно только в диалоге с числом участников больше 2")

    if not general and (not peer_id or not db.get(User, peer_id)):
        raise HTTPException(404, "Получатель не найден")

    msg = UserMessage(sender_id=user.id, recipient_id=None if general else peer_id,
                      is_general=general, content=question)
    db.add(msg)
    db.commit()
    db.refresh(msg)
    poll = Poll(message_id=msg.id, question=question, description=(description or "").strip() or None,
                allow_multiple=allow_multiple, show_voters=show_voters, allow_change=allow_change,
                allow_bot=allow_bot)
    db.add(poll)
    db.commit()
    db.refresh(poll)
    for i, t in enumerate(opts):
        db.add(PollOption(poll_id=poll.id, text=t, position=i))
    db.commit()

    flt = _thread_filter(user.id, peer_id, general)
    _mark_read(db, user.id, GENERAL_KEY if general else str(peer_id), flt)
    _broadcast(db, msg, user)
    return _serialize(msg, user.id, user, db)


@router.post("/poll/vote")
async def poll_vote(
    option_id: int = Body(..., embed=True),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    opt = db.get(PollOption, option_id)
    if not opt:
        raise HTTPException(404, "Вариант не найден")
    poll = db.get(Poll, opt.poll_id)
    msg = db.get(UserMessage, poll.message_id)
    if not msg or (not msg.is_general and user.id not in (msg.sender_id, msg.recipient_id)):
        raise HTTPException(403, "Нет доступа")

    my_votes = db.query(PollVote).filter(PollVote.poll_id == poll.id, PollVote.user_id == user.id).all()
    my_opt_ids = {v.option_id for v in my_votes}

    if option_id in my_opt_ids:
        # снятие голоса — если разрешено менять
        if poll.allow_change:
            for v in my_votes:
                if v.option_id == option_id:
                    db.delete(v)
    else:
        if poll.allow_multiple:
            db.add(PollVote(poll_id=poll.id, option_id=option_id, user_id=user.id))
        else:
            # один вариант: заменяем (если менять нельзя и уже голосовал — запрет)
            if my_votes and not poll.allow_change:
                raise HTTPException(400, "Изменение ответа запрещено")
            for v in my_votes:
                db.delete(v)
            db.add(PollVote(poll_id=poll.id, option_id=option_id, user_id=user.id))
    db.commit()

    for uid in set(_recipients_of(db, msg)):
        notify.publish(uid, {"type": "poll_updated", "id": msg.id,
                             "poll": _poll_of(db, msg.id, uid), "peer_key": _pk_for(msg, uid)})
    return {"ok": True, "poll": _poll_of(db, msg.id, user.id)}


# ─────────── голосование ботом по просьбе в чате (через /ask) ───────────
# Требуем ИМПЕРАТИВ («проголосуй», «выбери голос/вариант», «отдай голос»…), чтобы
# простое упоминание опроса («что было в голосовании?») не запускало голосование.
_VOTE_INTENT_RE = re.compile(
    r"(проголос\w*|отдай\s+(свой\s+)?голос|"
    r"выбери\s+(любой\s+|какой[- ]?нибудь\s+)?(голос|вариант)|"
    r"сделай\s+выбор\s+в\s+голосован|прими\s+участие\s+в\s+голосован|"
    r"поучаству\w*\s+в\s+голосован)",
    re.IGNORECASE,
)
_VOTE_RANDOM_RE = re.compile(r"(любой|случайн\w*|рандом\w*|наугад|как\s+хочешь|без\s+разниц)", re.IGNORECASE)


def _detect_vote_intent(content: str) -> Optional[str]:
    """None | 'random' | 'reason' — просит ли пользователь бота проголосовать."""
    if not _VOTE_INTENT_RE.search(content or ""):
        return None
    return "random" if _VOTE_RANDOM_RE.search(content or "") else "reason"


def _last_poll_in_thread(db: Session, flt):
    """Последнее голосование в диалоге: (poll_msg, Poll, [PollOption]) | None."""
    msgs = db.query(UserMessage).filter(flt).order_by(UserMessage.id.desc()).limit(60).all()
    for m in msgs:
        p = db.query(Poll).filter(Poll.message_id == m.id).first()
        if p:
            opts = db.query(PollOption).filter(PollOption.poll_id == p.id).order_by(PollOption.position).all()
            if opts:
                return m, p, opts
    return None


# Служебная строка выбора в голосовании (её пишет модель, пользователю НЕ видна):
# «ГОЛОС: 2», «ГОЛС 1», «**ГОЛОС: 1** (за …)», «VOTE: 1». Ловим только как ОТДЕЛЬНУЮ
# строку — чтобы не задеть обычные предложения про голосование. Негативный lookahead
# после «голос» отсекает «голосование…».
_VOTE_MARKER_RE = re.compile(
    r"(?im)^[^\S\r\n]*[*_#>\s]*(?:гол[оа]?с(?![а-яё])|vote)[*_\s]*[:#\-–—]?[*_\s]*"
    r"(\d+)[*_\s]*(?:\([^)]*\))?[*_\s]*$"
)


def _strip_vote_marker(text: str) -> str:
    """Вырезает служебную строку голосования из ответа модели (в любом виде)."""
    if not text:
        return text
    cleaned = _VOTE_MARKER_RE.sub("", text)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def _apply_bot_vote(vote: dict, answer_text: str) -> None:
    """Засчитывает голос бота после генерации ответа (отдельная сессия — зовётся из
    фонового потока стрима). vote: {mode, poll_id, msg_id, option_ids, chosen_idx}."""
    import random

    s = create_session()
    try:
        poll = s.get(Poll, vote["poll_id"])
        poll_msg = s.get(UserMessage, vote["msg_id"])
        option_ids = vote.get("option_ids") or []
        if not poll or not poll_msg or not option_ids or not getattr(poll, "allow_bot", True):
            return
        if vote["mode"] == "random":
            idx = vote.get("chosen_idx")
            if idx is None or idx < 0 or idx >= len(option_ids):
                idx = random.randrange(len(option_ids))
        else:
            m = _VOTE_MARKER_RE.search(answer_text or "")
            idx = (int(m.group(1)) - 1) if m else random.randrange(len(option_ids))
            if idx < 0 or idx >= len(option_ids):
                idx = 0
        bot = _get_bot_user(s)
        s.query(PollVote).filter(PollVote.poll_id == poll.id, PollVote.user_id == bot.id).delete()
        s.add(PollVote(poll_id=poll.id, option_id=option_ids[idx], user_id=bot.id))
        s.commit()
        for uid in set(_recipients_of(s, poll_msg)):
            notify.publish(uid, {"type": "poll_updated", "id": poll_msg.id,
                                 "poll": _poll_of(s, poll_msg.id, uid), "peer_key": _pk_for(poll_msg, uid)})
    except Exception as e:  # noqa: BLE001
        logger.warning("Голос бота не засчитан: {}", e)
    finally:
        s.close()
