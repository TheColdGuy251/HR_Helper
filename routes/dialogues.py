from __future__ import annotations

from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from data.chat_message import ChatMessage
from data.chat_sessions import ChatSession
from data.db_session import get_db
from data.dialogues import Dialogue
from data.users import User
from forms.chat import DialogueCreate, DialoguePatch
from utils.auth_deps import require_user

DEFAULT_TITLE = "Новый диалог"

router = APIRouter(prefix="/api/dialogues", tags=["dialogues"])


@router.get("")
async def list_dialogues(
    filter: str = Query(default="active"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    search: str | None = Query(default=None),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    # Показываем только «непустые» диалоги: есть хотя бы одно сообщение ИЛИ есть
    # черновик. Пустые (создан по «+», но ничего не введено) не сохраняются (#19).
    has_message = (
        db.query(ChatMessage.id)
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .filter(ChatSession.dialogue_id == Dialogue.id)
        .exists()
    )
    nonempty = or_(has_message, and_(Dialogue.draft.isnot(None), Dialogue.draft != ""))

    q = db.query(Dialogue).filter(Dialogue.user_id == user.id, nonempty)
    if filter == "active":
        q = q.filter(Dialogue.is_finished == False)  # noqa: E712
    elif filter == "finished":
        q = q.filter(Dialogue.is_finished == True)  # noqa: E712
    if search and search.strip():
        q = q.filter(Dialogue.title.ilike(f"%{search.strip()}%"))

    total = q.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    # Клампим страницу в допустимый диапазон, чтобы не отдавать пустоту
    if total_pages and page > total_pages:
        page = total_pages
    offset = (page - 1) * page_size
    items = (
        q.order_by(Dialogue.last_activity.desc())
        .offset(offset)
        .limit(page_size)
        .all()
    )

    payload = []
    for d in items:
        last_session = (
            db.query(ChatSession)
            .filter(ChatSession.dialogue_id == d.id)
            .order_by(ChatSession.last_activity.desc())
            .first()
        )
        session_ids = [
            s.id for s in db.query(ChatSession.id).filter(ChatSession.dialogue_id == d.id).all()
        ]

        # Превью последнего сообщения (для карточки диалога)
        last_message = None
        if session_ids:
            lm = (
                db.query(ChatMessage)
                .filter(ChatMessage.session_id.in_(session_ids))
                .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
                .first()
            )
            if lm:
                text = (lm.content or "").strip().replace("\n", " ")
                if len(text) > 140:
                    text = text[:140].rstrip() + "…"
                # Время сообщения для показа в превью (UTC → браузер локализует).
                lm_dt = (lm.finished_at or lm.created_at) if lm.role == "assistant" else lm.created_at
                lm_ts = lm_dt.replace(tzinfo=timezone.utc).isoformat() if lm_dt else None
                last_message = {"role": lm.role, "text": text, "ts": lm_ts}

        # Непрочитанные: завершённый ответ ассистента, который не прочитан
        unread = False
        if session_ids:
            unread = (
                db.query(ChatMessage.id)
                .filter(
                    ChatMessage.session_id.in_(session_ids),
                    ChatMessage.role == "assistant",
                    ChatMessage.is_read == False,  # noqa: E712
                    ChatMessage.is_finished == True,  # noqa: E712
                )
                .first()
                is not None
            )

        payload.append(
            {
                "id": d.id,
                "title": d.title,
                "description": d.description,
                "is_finished": d.is_finished,
                "created_at": d.created_at.isoformat(),
                "last_activity": d.last_activity.isoformat(),
                "session_id": last_session.id if last_session else None,
                "last_message": last_message,
                "unread": unread,
            }
        )

    # Статистика — тоже только по непустым диалогам (как и список).
    stats = {
        "total": db.query(func.count(Dialogue.id))
        .filter(Dialogue.user_id == user.id, nonempty)
        .scalar() or 0,
        "active": db.query(func.count(Dialogue.id))
        .filter(Dialogue.user_id == user.id, nonempty, Dialogue.is_finished == False)  # noqa: E712
        .scalar() or 0,
        "finished": db.query(func.count(Dialogue.id))
        .filter(Dialogue.user_id == user.id, nonempty, Dialogue.is_finished == True)  # noqa: E712
        .scalar() or 0,
    }
    return JSONResponse(
        {
            "success": True,
            "items": payload,
            "stats": stats,
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
        }
    )


def _find_empty_dialogue(db: Session, user_id: int):
    """Самый свежий активный диалог пользователя БЕЗ сообщений (пустой/черновик).
    Нужен, чтобы «+» не плодил новые чаты, а переиспользовал пустой (#19)."""
    candidates = (
        db.query(Dialogue)
        .filter(
            Dialogue.user_id == user_id,
            Dialogue.is_finished == False,  # noqa: E712
            # Диалог с ожидающей пересылкой из мессенджера «занят» — не переиспользуем.
            Dialogue.pending_forward.is_(None),
        )
        .order_by(Dialogue.last_activity.desc())
        .limit(30)
        .all()
    )
    for d in candidates:
        session_ids = [
            s.id for s in db.query(ChatSession.id).filter(ChatSession.dialogue_id == d.id).all()
        ]
        if not session_ids:
            return d, None
        has_msg = (
            db.query(ChatMessage.id)
            .filter(ChatMessage.session_id.in_(session_ids))
            .first()
        )
        if not has_msg:
            # последняя сессия этого диалога
            sess = (
                db.query(ChatSession)
                .filter(ChatSession.dialogue_id == d.id)
                .order_by(ChatSession.last_activity.desc())
                .first()
            )
            return d, sess
    return None, None


@router.post("")
async def create_dialogue(
    body: DialogueCreate,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    title = (body.title or "").strip()
    description = (body.description or "").strip()

    # Быстрое создание по «+» (без явных title/description): переиспользуем уже
    # существующий пустой диалог, чтобы не плодить чаты. Черновик (текст в поле
    # ввода) хранится на клиенте по session_id — при возврате он подхватится (#19).
    if not title and not description:
        existing, sess = _find_empty_dialogue(db, user.id)
        if existing is not None:
            if sess is None:
                sess = ChatSession(dialogue_id=existing.id)
                db.add(sess)
                db.commit()
                db.refresh(sess)
            return {
                "success": True,
                "dialogue_id": existing.id,
                "session_id": sess.id,
                "title": existing.title,
                "reused": True,
            }

    d = Dialogue(user_id=user.id, title=title or DEFAULT_TITLE, description=body.description)
    db.add(d)
    db.flush()
    s = ChatSession(dialogue_id=d.id)
    db.add(s)
    db.commit()
    db.refresh(d)
    db.refresh(s)
    return {"success": True, "dialogue_id": d.id, "session_id": s.id, "title": d.title}


@router.patch("/{dialogue_id}")
async def patch_dialogue(
    dialogue_id: int,
    body: DialoguePatch,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    d = db.get(Dialogue, dialogue_id)
    if not d or d.user_id != user.id:
        raise HTTPException(404, "Диалог не найден")
    if body.title is not None:
        t = (body.title or "").strip()
        d.title = t or DEFAULT_TITLE
    if body.description is not None:
        d.description = body.description or None
    if body.draft is not None:
        d.draft = body.draft or None  # пустая строка → None (диалог снова «пустой»)
    db.commit()
    return {"success": True, "title": d.title}


@router.post("/{dialogue_id}/finish")
async def finish_dialogue(
    dialogue_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    d = db.get(Dialogue, dialogue_id)
    if not d or d.user_id != user.id:
        raise HTTPException(404, "Диалог не найден")
    d.is_finished = True
    db.commit()
    return {"success": True}


@router.post("/{dialogue_id}/reopen")
async def reopen_dialogue(
    dialogue_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    d = db.get(Dialogue, dialogue_id)
    if not d or d.user_id != user.id:
        raise HTTPException(404, "Диалог не найден")
    d.is_finished = False
    db.commit()
    return {"success": True}


def _auto_title_worker(dialogue_id: int, user_id: int) -> None:
    """Фоновая задача: подбирает короткое имя диалога через LLM и сохраняет в БД.
    Запускается в отдельном потоке, чтобы НЕ блокировать HTTP-воркер uvicorn
    (LLM-вызовы синхронные и долгие). UI узнаёт об обновлении при следующем
    GET /api/dialogues."""
    from data.db_session import create_session
    from services.llm import get_llm
    from services.llm.prompts import SYSTEM_PROMPT_DIALOGUE_TITLE
    from utils.logger import logger

    db = create_session()
    try:
        d = db.get(Dialogue, dialogue_id)
        if not d or d.user_id != user_id:
            return
        current = (d.title or "").strip()
        if current and current != DEFAULT_TITLE:
            return

        msgs = (
            db.query(ChatMessage)
            .join(ChatSession, ChatMessage.session_id == ChatSession.id)
            .filter(ChatSession.dialogue_id == d.id, ChatMessage.is_finished == True)  # noqa: E712
            .order_by(ChatMessage.id.asc())
            .limit(4)
            .all()
        )
        if not msgs:
            return

        body = "\n".join(
            f"{'Пользователь' if m.role == 'user' else 'Ассистент'}: {m.content[:600]}"
            for m in msgs
        )[:2400]

        try:
            raw = get_llm().generate_text(
                SYSTEM_PROMPT_DIALOGUE_TITLE, body, max_tokens=24, temperature=0.2
            )
        except Exception as e:
            logger.warning("auto-title LLM call failed: {}", e)
            return

        title = (raw or "").strip().strip('«»"\'').rstrip(".").strip()
        if not title or len(title) > 80:
            return

        # Перепроверим — пользователь мог за это время задать своё название
        d = db.get(Dialogue, dialogue_id)
        if not d:
            return
        if (d.title or "").strip() not in ("", DEFAULT_TITLE):
            return
        d.title = title
        db.commit()
        logger.info("[DIALOGUE {}] auto-title set: '{}'", dialogue_id, title)

        # Push-уведомление: название готово (#16) — клиент обновит список/тост.
        try:
            from services import notify

            notify.publish(user_id, {
                "type": "dialogue_title",
                "dialogue_id": dialogue_id,
                "title": title,
            })
        except Exception as e:
            logger.debug("notify dialogue_title failed: {}", e)
    except Exception as e:
        logger.warning("auto-title worker failed: {}", e)
    finally:
        db.close()


@router.post("/{dialogue_id}/auto-title")
async def auto_title_dialogue(
    dialogue_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Запускает фоновую генерацию названия диалога и возвращает ответ МГНОВЕННО.
    Реальная работа уходит в отдельный поток, чтобы не блокировать ни этот HTTP-воркер,
    ни LLM-очередь (она строится сама собой через общий lock).
    UI узнаёт о новом имени при следующем GET /api/dialogues."""
    import threading

    d = db.get(Dialogue, dialogue_id)
    if not d or d.user_id != user.id:
        raise HTTPException(404, "Диалог не найден")

    current = (d.title or "").strip()
    if current and current != DEFAULT_TITLE:
        return {"success": True, "title": current, "scheduled": False, "reason": "already_set"}

    threading.Thread(
        target=_auto_title_worker,
        args=(dialogue_id, user.id),
        daemon=True,
    ).start()
    return {"success": True, "title": d.title, "scheduled": True}


@router.delete("/{dialogue_id}")
async def delete_dialogue(
    dialogue_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    d = db.get(Dialogue, dialogue_id)
    if not d or d.user_id != user.id:
        raise HTTPException(404, "Диалог не найден")
    db.delete(d)
    db.commit()
    return {"success": True}
