"""Администрирование: управление пользователями (роли, удаление), просмотр их
переписок с ботом и с коллегами, журнал действий с данными.

Все эндпоинты — только для администраторов (require_admin). Страница — /admin."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from data.chat_message import ChatMessage
from data.chat_sessions import ChatSession
from data.dialogues import Dialogue
from data.db_session import get_db
from data.pii import PIIAuditLog
from data.user_message import UserMessage, UserMessageFile
from data.users import User
from utils.auth_deps import require_admin, require_admin_redirect
from utils.logger import logger
from utils.templating import render

router = APIRouter()


def _user_brief(u: User) -> dict:
    return {
        "id": u.id,
        "full_name": u.full_name,
        "short_name": u.short_name,
        "initials": u.initials,
        "email": u.email,
        "username": u.username,
        "position": u.position,
        "is_active": bool(u.is_active),
        "is_admin": bool(u.is_admin),
        "is_kb_editor": bool(u.is_kb_editor),
        "can_access_pii": bool(u.can_access_pii),
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


# ───────────────────────────── страница ─────────────────────────────
@router.get("/admin", name="page_admin")
async def admin_page(request: Request, user: User = Depends(require_admin_redirect)):
    return render(request, "admin.html", {})


# ───────────────────────── пользователи ─────────────────────────
@router.get("/api/admin/users")
async def list_users(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    users = db.query(User).order_by(User.surname.asc(), User.name.asc()).all()
    return JSONResponse({"success": True, "items": [_user_brief(u) for u in users]})


_ROLE_FIELDS = {"is_admin", "is_kb_editor", "can_access_pii", "is_active"}


@router.patch("/api/admin/users/{uid}")
async def update_user(
    uid: int,
    payload: dict = Body(...),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    target = db.get(User, uid)
    if not target:
        raise HTTPException(404, "Пользователь не найден")

    # Защита от «отстрела себе ноги»: нельзя снять с себя админку или деактивировать себя.
    if target.id == admin.id and (
        payload.get("is_admin") is False or payload.get("is_active") is False
    ):
        raise HTTPException(400, "Нельзя снять права администратора или деактивировать себя")

    changed = {}
    for field in _ROLE_FIELDS:
        if field in payload:
            val = bool(payload[field])
            if getattr(target, field) != val:
                setattr(target, field, val)
                changed[field] = val
    if changed:
        db.commit()
        logger.info("Админ {} изменил пользователя {}: {}", admin.id, target.id, changed)
    return JSONResponse({"success": True, "item": _user_brief(target)})


@router.delete("/api/admin/users/{uid}")
async def delete_user(
    uid: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if uid == admin.id:
        raise HTTPException(400, "Нельзя удалить собственную учётную запись")
    target = db.get(User, uid)
    if not target:
        raise HTTPException(404, "Пользователь не найден")
    # FK-каскады (PRAGMA foreign_keys=ON) удалят диалоги, сессии, сообщения бота и
    # мессенджера. Аудит и загруженные PII-файлы отвязываются (SET NULL).
    name = target.full_name
    db.delete(target)
    db.commit()
    logger.info("Админ {} удалил пользователя {} ({})", admin.id, uid, name)
    return JSONResponse({"success": True})


# ───────────────────── диалоги с ботом ─────────────────────
@router.get("/api/admin/users/{uid}/dialogues")
async def user_dialogues(
    uid: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if not db.get(User, uid):
        raise HTTPException(404, "Пользователь не найден")
    dialogues = (
        db.query(Dialogue)
        .filter(Dialogue.user_id == uid)
        .order_by(Dialogue.last_activity.desc())
        .all()
    )
    items = []
    for d in dialogues:
        session_ids = [s.id for s in db.query(ChatSession.id).filter(ChatSession.dialogue_id == d.id)]
        count = 0
        if session_ids:
            count = (
                db.query(ChatMessage.id)
                .filter(ChatMessage.session_id.in_(session_ids))
                .count()
            )
        items.append({
            "id": d.id,
            "title": d.title or "Без названия",
            "is_finished": bool(d.is_finished),
            "last_activity": d.last_activity.isoformat() if d.last_activity else None,
            "messages": count,
        })
    return JSONResponse({"success": True, "items": items})


@router.get("/api/admin/users/{uid}/dialogues/{did}/messages")
async def user_dialogue_messages(
    uid: int,
    did: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    dialogue = db.get(Dialogue, did)
    if not dialogue or dialogue.user_id != uid:
        raise HTTPException(404, "Диалог не найден")
    session_ids = [s.id for s in db.query(ChatSession.id).filter(ChatSession.dialogue_id == did)]
    msgs = []
    if session_ids:
        msgs = (
            db.query(ChatMessage)
            .filter(
                ChatMessage.session_id.in_(session_ids),
                ChatMessage.variant_active.is_(True),
                ChatMessage.role.in_(("user", "assistant")),
            )
            .order_by(ChatMessage.id.asc())
            .all()
        )
    items = [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content or "",
            "sources": len(m.sources or []),
            "created_at": (m.finished_at or m.created_at).isoformat()
            if (m.finished_at or m.created_at) else None,
        }
        for m in msgs
    ]
    return JSONResponse({
        "success": True,
        "title": dialogue.title or "Без названия",
        "items": items,
    })


# ───────────────────── переписки с коллегами ─────────────────────
@router.get("/api/admin/users/{uid}/messenger")
async def user_messenger_conversations(
    uid: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if not db.get(User, uid):
        raise HTTPException(404, "Пользователь не найден")
    msgs = (
        db.query(UserMessage)
        .filter(or_(UserMessage.sender_id == uid, UserMessage.recipient_id == uid))
        .all()
    )
    convs: dict[str, dict] = {}
    for m in msgs:
        # Служебные строки (закрепление/открепление) — не переписка, пропускаем.
        if m.forwarded_meta and m.forwarded_meta.get("system"):
            continue
        if m.is_general:
            key, peer_id = "general", None
        else:
            peer_id = m.recipient_id if m.sender_id == uid else m.sender_id
            key = str(peer_id)
        c = convs.setdefault(key, {"peer_id": peer_id, "count": 0, "last_at": None})
        c["count"] += 1
        if c["last_at"] is None or (m.created_at and m.created_at > c["last_at"]):
            c["last_at"] = m.created_at

    peer_ids = [c["peer_id"] for c in convs.values() if c["peer_id"]]
    names = {u.id: u for u in db.query(User).filter(User.id.in_(peer_ids)).all()} if peer_ids else {}
    items = []
    for key, c in convs.items():
        if key == "general":
            title = "Общий чат"
        else:
            u = names.get(c["peer_id"])
            title = u.full_name if u else f"Пользователь #{c['peer_id']}"
        items.append({
            "key": key,
            "title": title,
            "count": c["count"],
            "last_at": c["last_at"].isoformat() if c["last_at"] else None,
        })
    items.sort(key=lambda x: x["last_at"] or "", reverse=True)
    return JSONResponse({"success": True, "items": items})


@router.get("/api/admin/users/{uid}/messenger/{peer_key}")
async def user_messenger_messages(
    uid: int,
    peer_key: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if not db.get(User, uid):
        raise HTTPException(404, "Пользователь не найден")
    if peer_key == "general":
        q = db.query(UserMessage).filter(UserMessage.is_general.is_(True))
    else:
        try:
            peer = int(peer_key)
        except ValueError:
            raise HTTPException(400, "Некорректный собеседник")
        q = db.query(UserMessage).filter(
            UserMessage.is_general.is_(False),
            or_(
                and_(UserMessage.sender_id == uid, UserMessage.recipient_id == peer),
                and_(UserMessage.sender_id == peer, UserMessage.recipient_id == uid),
            ),
        )
    rows = q.order_by(UserMessage.created_at.asc()).limit(1000).all()

    sender_ids = {m.sender_id for m in rows}
    names = {u.id: u for u in db.query(User).filter(User.id.in_(sender_ids)).all()} if sender_ids else {}
    file_map: dict[int, list] = {}
    msg_ids = [m.id for m in rows]
    if msg_ids:
        for f in db.query(UserMessageFile).filter(UserMessageFile.message_id.in_(msg_ids)).all():
            file_map.setdefault(f.message_id, []).append(f.original_name)

    items = []
    for m in rows:
        # Служебные строки («закрепил(а)/открепил(а) сообщение») не показываем —
        # это не часть переписки (иначе выглядят как «диалог с собой»).
        if m.forwarded_meta and m.forwarded_meta.get("system"):
            continue
        u = names.get(m.sender_id)
        items.append({
            "id": m.id,
            "sender_id": m.sender_id,
            "sender_name": u.short_name if u else f"#{m.sender_id}",
            "is_target": m.sender_id == uid,
            "content": m.content or "",
            "forwarded": bool(m.forwarded_meta) and not m.forwarded_meta.get("system"),
            "attachments": file_map.get(m.id, []),
            "created_at": m.created_at.isoformat() if m.created_at else None,
        })
    return JSONResponse({"success": True, "items": items})


# ───────────────────── действия с данными ─────────────────────
@router.get("/api/admin/users/{uid}/activity")
async def user_activity(
    uid: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if not db.get(User, uid):
        raise HTTPException(404, "Пользователь не найден")

    dialogues_count = db.query(Dialogue.id).filter(Dialogue.user_id == uid).count()
    sent_count = db.query(UserMessage.id).filter(UserMessage.sender_id == uid).count()
    files_count = db.query(UserMessageFile.id).filter(UserMessageFile.owner_id == uid).count()

    audit = (
        db.query(PIIAuditLog)
        .filter(PIIAuditLog.user_id == uid)
        .order_by(PIIAuditLog.id.desc())
        .limit(300)
        .all()
    )
    audit_items = [
        {
            "id": r.id,
            "at": r.at.isoformat() if r.at else None,
            "action": r.action,
            "entity": r.entity,
            "entity_id": r.entity_id,
            "extra": r.extra,
        }
        for r in audit
    ]
    return JSONResponse({
        "success": True,
        "stats": {
            "dialogues": dialogues_count,
            "sent_messages": sent_count,
            "files": files_count,
        },
        "audit": audit_items,
    })
