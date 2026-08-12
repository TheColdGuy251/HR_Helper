"""Автоудаление содержимого с персональными данными (ТЗ: ПДн не храним).

Периодический job:
1) удаляет сообщения чата с ассистентом, помеченные meta.pii_doc (и запрос
   пользователя, и ответ бота), вместе с вложениями-выгрузками и самим
   сгенерированным документом (файл + строка my_documents);
2) удаляет «осиротевшие» ПДн-документы (сгенерированные с главной страницы —
   у них нет сообщения чата);
3) если диалог после удаления остался пустым (нет сообщений и черновика) —
   удаляет диалог целиком;
4) удаляет пересланные в мессенджер ПДн-ответы (forwarded_meta.pii);
5) шлёт адресные системные уведомления затронутым пользователям.

TTL задаётся PII_TTL_MINUTES (services/documents/pii_policy.py) — окно, за
которое пользователь успевает скачать нужный файл из сообщения.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from config import settings
from data.db_session import create_session
from services.documents.pii_policy import PII_TTL_MINUTES
from utils.logger import logger


def _unlink_generated(file_path: str | None) -> None:
    """Удаляет файл с диска, только если он внутри docs/ (path-traversal-safe)."""
    if not file_path:
        return
    try:
        p = Path(file_path).resolve()
        p.relative_to(settings.docs_dir.resolve())
        p.unlink(missing_ok=True)
    except (ValueError, OSError):
        pass


def _cleanup_chat(db, cutoff, deleted: dict) -> None:
    """Сообщения чата с meta.pii_doc + их вложения и документы + пустые диалоги."""
    from data.chat_message import ChatMessage
    from data.chat_sessions import ChatSession
    from data.dialogues import Dialogue
    from data.my_documents import MyDocuments
    from data.session_documents import SessionDocument

    candidates = (
        db.query(ChatMessage)
        .filter(ChatMessage.created_at < cutoff, ChatMessage.meta.isnot(None))
        .all()
    )
    pii_msgs = [m for m in candidates if (m.meta or {}).get("pii_doc")]
    if not pii_msgs:
        return

    affected_dialogues: set[int] = set()
    for m in pii_msgs:
        s = db.get(ChatSession, m.session_id)
        dlg = db.get(Dialogue, s.dialogue_id) if s else None
        owner_id = dlg.user_id if dlg else None
        if dlg:
            affected_dialogues.add(dlg.id)

        # Сгенерированный ПДн-документ, прикреплённый к ответу
        if m.attachment_document_id:
            doc = db.get(MyDocuments, m.attachment_document_id)
            if doc is not None:
                _unlink_generated(doc.file_path)
                db.delete(doc)
                if owner_id:
                    deleted[owner_id]["docs"] += 1

        # Вложения-выгрузки пользователя (исходники с ПДн) — файл и строка
        for sd in db.query(SessionDocument).filter(SessionDocument.message_id == m.id).all():
            if sd.stored_path:
                _unlink_generated(sd.stored_path)
            db.delete(sd)

        db.delete(m)
        if owner_id:
            deleted[owner_id]["messages"] += 1
    db.commit()

    # Пустые диалоги (нет ни одного сообщения и нет черновика) — удаляем целиком
    for dlg_id in affected_dialogues:
        dlg = db.get(Dialogue, dlg_id)
        if dlg is None:
            continue
        has_msg = (
            db.query(ChatMessage.id)
            .join(ChatSession, ChatMessage.session_id == ChatSession.id)
            .filter(ChatSession.dialogue_id == dlg_id)
            .first()
        )
        if has_msg is None and not (dlg.draft or "").strip():
            deleted[dlg.user_id]["dialogues"].append(dlg.title or "Без названия")
            db.delete(dlg)
    db.commit()


def _cleanup_orphan_docs(db, cutoff, deleted: dict) -> None:
    """ПДн-документы без сообщения чата (созданы с главной страницы)."""
    from data.chat_message import ChatMessage
    from data.my_documents import MyDocuments

    docs = (
        db.query(MyDocuments)
        .filter(MyDocuments.is_pii.is_(True), MyDocuments.created_at < cutoff)
        .all()
    )
    for doc in docs:
        referenced = (
            db.query(ChatMessage.id)
            .filter(ChatMessage.attachment_document_id == doc.id)
            .first()
        )
        if referenced is not None:
            continue  # удалится вместе с сообщением в _cleanup_chat
        _unlink_generated(doc.file_path)
        db.delete(doc)
        deleted[doc.user_id]["docs"] += 1
    db.commit()


def _cleanup_messenger(db, cutoff, deleted: dict) -> None:
    """Пересланные в мессенджер ПДн-ответы ассистента (forwarded_meta.pii)."""
    from data.user_message import UserMessage, UserMessageFile
    from routes.messenger import GENERAL_KEY, _UPLOAD_DIR, _recipients_of
    from services import notify

    candidates = (
        db.query(UserMessage)
        .filter(UserMessage.created_at < cutoff, UserMessage.forwarded_meta.isnot(None))
        .all()
    )
    pii_msgs = [m for m in candidates if (m.forwarded_meta or {}).get("pii")]
    for m in pii_msgs:
        peer_key_map = {
            uid: (GENERAL_KEY if m.is_general else str(m.sender_id if uid != m.sender_id else m.recipient_id))
            for uid in _recipients_of(db, m)
        }
        for f in db.query(UserMessageFile).filter(UserMessageFile.message_id == m.id).all():
            try:
                p = Path(f.stored_path).resolve()
                p.relative_to(_UPLOAD_DIR.resolve())
                p.unlink(missing_ok=True)
            except (ValueError, OSError):
                pass
        msg_id = m.id
        sender_id = m.sender_id
        db.delete(m)
        db.commit()
        deleted[sender_id]["messenger"] += 1
        for uid, pk in peer_key_map.items():
            notify.publish(uid, {"type": "user_message_deleted", "id": msg_id, "peer_key": pk})


def _notify_users(deleted: dict) -> None:
    """Адресные системные уведомления затронутым пользователям."""
    from data.notifications import Notification
    from services import notify

    db = create_session()
    try:
        for user_id, d in deleted.items():
            if not user_id:
                continue
            parts = []
            if d["messages"]:
                parts.append(f"сообщений в диалогах с ИИ: {d['messages']}")
            if d["docs"]:
                parts.append(f"сгенерированных документов: {d['docs']}")
            if d["messenger"]:
                parts.append(f"пересылок в мессенджере: {d['messenger']}")
            if not parts and not d["dialogues"]:
                continue
            body = "По регламенту документы и переписка с персональными данными не хранятся. Удалено: " + \
                (", ".join(parts) if parts else "—") + "."
            if d["dialogues"]:
                names = ", ".join(f"«{t}»" for t in d["dialogues"][:5])
                body += f" Опустевшие диалоги удалены полностью: {names}."
            n = Notification(
                kind="pii_autodeleted",
                user_id=user_id,
                title="Автоудаление данных с ПДн",
                body=body,
            )
            db.add(n)
            db.commit()
            notify.publish(user_id, {"type": "system_notification", "kind": "pii_autodeleted", "id": n.id})
    finally:
        db.close()


def pii_autodelete_job() -> None:
    cutoff = datetime.utcnow() - timedelta(minutes=PII_TTL_MINUTES)
    # user_id -> счётчики удалённого (для текста уведомления)
    deleted: dict[int, dict] = defaultdict(
        lambda: {"messages": 0, "docs": 0, "messenger": 0, "dialogues": []}
    )
    db = create_session()
    try:
        _cleanup_chat(db, cutoff, deleted)
        _cleanup_orphan_docs(db, cutoff, deleted)
        _cleanup_messenger(db, cutoff, deleted)
    except Exception as e:
        db.rollback()
        logger.warning("[PII-CLEANUP] ошибка: {}", e)
    finally:
        db.close()

    if deleted:
        total = {k: v for k, v in deleted.items()}
        logger.info("[PII-CLEANUP] удалено по пользователям: {}", dict(total))
        _notify_users(deleted)
