"""Центр уведомлений (колокольчик в шапке): три источника.

- messenger — диалоги мессенджера с непрочитанными сообщениями от людей
  (исчезают из списка, как только диалог прочитан);
- ai — диалоги с непрочитанными ответами ИИ-ассистента (та же логика);
- system — постоянные уведомления (обновления веб-страниц БЗ и т.п.):
  прочтение гасит бейдж, но записи остаются в списке.
"""
from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from data.chat_message import ChatMessage
from data.chat_sessions import ChatSession
from data.db_session import get_db
from data.dialogues import Dialogue
from data.notifications import Notification, NotificationRead
from data.user_message import MessengerRead, UserMessage
from data.users import User
from utils.auth_deps import require_user

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

_GENERAL_KEY = "general"


def _messenger_items(db: Session, user: User) -> list[dict]:
    reads = {
        r.peer_key: r.last_read_id
        for r in db.query(MessengerRead).filter(MessengerRead.user_id == user.id).all()
    }
    items: list[dict] = []

    def _is_system(m: UserMessage) -> bool:
        return bool((m.forwarded_meta or {}).get("system"))

    def _preview(m: UserMessage) -> str:
        fm = m.forwarded_meta or {}
        if fm and not fm.get("from_user"):
            return "Ответ ассистента" if fm.get("ai") else "↪ пересланное сообщение"
        return ((m.content or "") or "📎 вложение")[:80]

    # Общий чат. Системные строки («закрепил(а) сообщение») — не уведомления.
    lr = reads.get(_GENERAL_KEY, 0)
    g_msgs = [
        m for m in (
            db.query(UserMessage)
            .filter(
                UserMessage.is_general.is_(True),
                UserMessage.sender_id != user.id,
                UserMessage.id > lr,
            )
            .order_by(UserMessage.id.desc())
            .limit(500)
            .all()
        )
        if not _is_system(m)
    ]
    if g_msgs:
        last = g_msgs[0]
        items.append({
            "peer_key": _GENERAL_KEY, "is_general": True,
            "name": "Общий чат", "initials": "★",
            "unread": len(g_msgs), "preview": _preview(last),
            "at": last.created_at.isoformat() if last.created_at else None,
        })

    # Личные диалоги: входящие, непрочитанные (группируем по отправителю)
    rows = (
        db.query(UserMessage)
        .filter(UserMessage.is_general.is_(False), UserMessage.recipient_id == user.id)
        .order_by(UserMessage.id.desc())
        .limit(2000)
        .all()
    )
    by_sender: dict[int, list[UserMessage]] = defaultdict(list)
    for m in rows:
        if m.id > reads.get(str(m.sender_id), 0) and not _is_system(m):
            by_sender[m.sender_id].append(m)
    for sender_id, msgs in by_sender.items():
        u = db.get(User, sender_id)
        last = msgs[0]  # rows отсортированы по убыванию id
        items.append({
            "peer_key": str(sender_id), "is_general": False, "peer_id": sender_id,
            "name": u.full_name if u else "Сотрудник",
            "short_name": u.short_name if u else "—",
            "initials": u.initials if u else "?",
            "unread": len(msgs), "preview": _preview(last),
            "at": last.created_at.isoformat() if last.created_at else None,
        })
    items.sort(key=lambda x: x.get("at") or "", reverse=True)
    return items


def _ai_items(db: Session, user: User) -> list[dict]:
    rows = (
        db.query(ChatMessage, ChatSession.dialogue_id, Dialogue.title)
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .join(Dialogue, ChatSession.dialogue_id == Dialogue.id)
        .filter(
            Dialogue.user_id == user.id,
            ChatMessage.role == "assistant",
            ChatMessage.is_read.is_(False),
            ChatMessage.is_finished.is_(True),
        )
        .order_by(ChatMessage.id.desc())
        .all()
    )
    by_dialogue: dict[int, dict] = {}
    for m, dlg_id, title in rows:
        slot = by_dialogue.setdefault(dlg_id, {
            "dialogue_id": dlg_id,
            "title": title or "Диалог",
            "session_id": m.session_id,
            "unread": 0,
            "preview": (m.content or "").replace("\n", " ")[:80],
            "at": (m.finished_at or m.created_at).isoformat()
            if (m.finished_at or m.created_at) else None,
        })
        slot["unread"] += 1
    return list(by_dialogue.values())


def _system_items(db: Session, user: User) -> tuple[list[dict], int]:
    notes = db.query(Notification).order_by(Notification.id.desc()).limit(50).all()
    read_ids = {
        r.notification_id
        for r in db.query(NotificationRead).filter(NotificationRead.user_id == user.id).all()
    }
    items = [
        {
            "id": n.id,
            "kind": n.kind,
            "title": n.title,
            "body": n.body,
            "document_id": n.document_id,
            "at": n.created_at.isoformat() if n.created_at else None,
            "is_read": n.id in read_ids,
            "diff_url": (
                f"/kb/documents/{n.document_id}/view?diff={n.id}"
                if n.kind == "web_update" and n.document_id
                # А7 (doc_expired/doc_stale): клик открывает сам документ
                else (f"/kb/documents/{n.document_id}/view" if n.document_id else None)
            ),
        }
        for n in notes
    ]
    unread = sum(1 for i in items if not i["is_read"])
    return items, unread


@router.get("")
async def list_notifications(
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    messenger = _messenger_items(db, user)
    ai = _ai_items(db, user)
    system, system_unread = _system_items(db, user)
    return {
        "success": True,
        "messenger": messenger,
        "ai": ai,
        "system": system,
        "counts": {
            "messenger": sum(i["unread"] for i in messenger),
            "ai": sum(i["unread"] for i in ai),
            "system": system_unread,
        },
    }


@router.post("/system/read")
async def mark_system_read(
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Помечает ВСЕ системные уведомления просмотренными (гасит бейдж;
    записи остаются в списке)."""
    read_ids = {
        r.notification_id
        for r in db.query(NotificationRead).filter(NotificationRead.user_id == user.id).all()
    }
    for n in db.query(Notification).all():
        if n.id not in read_ids:
            db.add(NotificationRead(notification_id=n.id, user_id=user.id))
    db.commit()
    return {"success": True}


@router.post("/{notification_id}/read")
async def mark_one_read(
    notification_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    n = db.get(Notification, notification_id)
    if not n:
        raise HTTPException(404, "Уведомление не найдено")
    exists = (
        db.query(NotificationRead)
        .filter(
            NotificationRead.notification_id == notification_id,
            NotificationRead.user_id == user.id,
        )
        .first()
    )
    if not exists:
        db.add(NotificationRead(notification_id=notification_id, user_id=user.id))
        db.commit()
    return {"success": True}
