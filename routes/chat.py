from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator

import os
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, Form
from fastapi.responses import StreamingResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from config import settings
from data.chat_message import ChatMessage
from data.chat_feedback import ChatFeedback
from data.chat_sessions import ChatSession
from data.db_session import create_session, get_db
from data.dialogues import Dialogue
from data.session_documents import SessionDocument
from data.users import User
from forms.chat import (
    AbortRequest,
    ChatStreamRequest,
    EditMessageRequest,
    MarkReadRequest,
    VariantSwitchRequest,
)
from services.documents import generate_document
from services.documents.intent import (
    detect_template,
    extract_fields,
    fill_defaults,
    looks_like_doc_request,
    missing_required_fields,
    ru_field_label,
    summarize_for_title,
    validate_fields,
    wants_cancel,
    wants_correction,
    wants_force_generate,
)
from services.llm import get_llm
from services.llm.prompts import SYSTEM_PROMPT_DOC_REPLY
from services.parsers import parse_file
from services.rag.pipeline import get_pipeline
from utils.auth_deps import require_user
from utils.logger import logger

router = APIRouter(prefix="/api/chat", tags=["chat"])


def _utc_iso(dt: datetime | None) -> str | None:
    """Наивный UTC-datetime (created_at/finished_at) → ISO с меткой UTC, чтобы браузер
    показал время в локальной зоне пользователя и корректно определил «сегодня»."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Пересланные из мессенджера сообщения (см. /api/messenger/forward-to-assistant)
# ---------------------------------------------------------------------------


def _format_forward_block(items: list | None) -> str:
    """Читаемый блок пересланных сообщений для промпта модели: кто, из какого
    чата, когда и что написал (+имена вложений)."""
    lines = ["Пользователь переслал сообщения из корпоративного мессенджера:"]
    for i, it in enumerate(items or [], start=1):
        when = ""
        try:
            raw = (it.get("sent_at") or "").replace("Z", "+00:00")
            if raw:
                when = datetime.fromisoformat(raw).strftime("%d.%m.%Y %H:%M")
        except ValueError:
            pass
        who = it.get("from_name") or "—"
        head = f"{i}. [{it.get('chat') or 'чат'}] От: {who}" + (f", {when} UTC" if when else "")
        text = (it.get("text") or "").strip() or "(без текста)"
        atts = ", ".join(a.get("name", "") for a in (it.get("attachments") or []) if a.get("name"))
        if atts:
            text += f" [вложения: {atts}]"
        lines.append(f"{head}: {text}")
    return "\n".join(lines)


def _gen_text_for_user_message(
    msg_text: str, fwd: list | None, use_rag: bool
) -> tuple[str, bool, bool]:
    """Готовит текст запроса к пайплайну для сообщения с пересланным блоком.
    Возвращает (текст, use_rag, forwarded). Без комментария пользователя RAG
    отключаем: предмет — сами пересланные сообщения, а поиск по ним в базе знаний
    находит случайные документы и уводит ответ в сторону."""
    if not fwd:
        return msg_text, use_rag, False
    block = _format_forward_block(fwd)
    if msg_text:
        return (
            f"{block}\n\nВопрос/комментарий пользователя к пересланному: {msg_text}",
            use_rag,
            True,
        )
    return (
        f"{block}\n\nПользователь переслал эти сообщения без комментария. "
        "Кратко отреагируй по их содержанию: если в них есть вопрос — ответь на него, "
        "иначе поясни суть и предложи, чем можешь помочь.",
        False,
        True,
    )


def _history_entry_content(m: ChatMessage) -> str:
    """Текст сообщения для истории модели: пересланный блок + собственный текст."""
    if m.role == "user" and m.forwarded_meta:
        block = _format_forward_block(m.forwarded_meta)
        return f"{block}\n\n{m.content}" if m.content else block
    return m.content


# ---------------------------------------------------------------------------
# Ветвление диалога (правки вопросов / ретраи ответов)
# ---------------------------------------------------------------------------


def _hidden_message_ids(msgs: list[ChatMessage]) -> set[int]:
    """Сообщения, НЕ принадлежащие активной ветке диалога.

    Диалог — дерево: правка вопроса или ретрай ответа создаёт вариант, у каждого
    сообщения есть «якорь» (ответ ассистента — на свой вопрос через reply_to;
    вопрос — на ответ, после которого он был задан, через branch_of). Скрываем
    неактивные варианты и — каскадно — всё, что на них навешано. Для записей до
    внедрения branch_of якорь вопроса — ближайший предыдущий ответ по id."""
    from collections import defaultdict

    groups: dict[tuple, list[ChatMessage]] = defaultdict(list)
    for m in msgs:
        groups[(m.role, m.variant_group or m.id)].append(m)

    hidden: set[int] = set()
    for variants in groups.values():
        if len(variants) < 2:
            continue
        act = next((x for x in variants if x.variant_active), variants[-1])
        hidden.update(v.id for v in variants if v.id != act.id)

    assist_ids = [m.id for m in msgs if m.role == "assistant"]

    def _anchor(m: ChatMessage) -> int | None:
        if m.role == "assistant":
            return m.reply_to
        if m.branch_of:
            return m.branch_of
        # Фолбэк без branch_of: ближайший предыдущий ответ. Позицию берём по ПЕРВОМУ
        # варианту группы — правка позднее создаёт вариант с большим id, но логически
        # он стоит на месте исходного вопроса (иначе прицепится к чужой ветке).
        pos = groups[(m.role, m.variant_group or m.id)][0].id
        prev = [i for i in assist_ids if i < pos]
        return prev[-1] if prev else None

    changed = True
    while changed:
        changed = False
        for m in msgs:
            if m.id in hidden:
                continue
            a = _anchor(m)
            if a and a in hidden:
                hidden.add(m.id)
                changed = True
    return hidden


# ---------------------------------------------------------------------------
# Реестр активных стримов (в памяти процесса). Подходит для одного воркера.
# ---------------------------------------------------------------------------


@dataclass
class StreamState:
    session_id: str
    message_id: int
    started_at: datetime
    buffer: list[str] = field(default_factory=list)  # последовательные чанки
    finished: bool = False
    cancelled: bool = False
    status: str = "search"  # search | rerank | generate
    sources: list = field(default_factory=list)  # структурные источники (готовы ДО текста)
    # id только что созданного сообщения пользователя (для обычной отправки) — чтобы
    # клиент сразу проставил его пузырю id и показал кнопку «изменить».
    user_message_id: int | None = None
    event: asyncio.Event = field(default_factory=asyncio.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def content(self) -> str:
        return "".join(self.buffer)

    @property
    def last_seq(self) -> int:
        return len(self.buffer)

    def append(self, chunk: str):
        with self.lock:
            self.buffer.append(chunk)


_active_streams: dict[int, StreamState] = {}
_streams_by_session: dict[str, set[int]] = {}
_streams_lock = threading.Lock()


def _register_stream(state: StreamState):
    with _streams_lock:
        _active_streams[state.message_id] = state
        _streams_by_session.setdefault(state.session_id, set()).add(state.message_id)


def _unregister_stream(state: StreamState):
    with _streams_lock:
        _active_streams.pop(state.message_id, None)
        s = _streams_by_session.get(state.session_id)
        if s:
            s.discard(state.message_id)
            if not s:
                _streams_by_session.pop(state.session_id, None)


def _get_stream(message_id: int) -> StreamState | None:
    return _active_streams.get(message_id)


# ---------------------------------------------------------------------------
# Диалоговый добор полей для генерации документа. Когда не хватает обязательных
# полей, запоминаем шаблон + уже собранные значения по session_id; следующее
# сообщение пользователя досказывает недостающее. Хранится в памяти процесса (как
# реестр стримов): single-worker, короткоживущий контекст. При рестарте пользователь
# просто повторит команду.
# ---------------------------------------------------------------------------

_pending_docgen: dict[str, dict] = {}
_pending_lock = threading.Lock()


def _set_pending(session_id: str, template_key: str, fields: dict) -> None:
    with _pending_lock:
        _pending_docgen[session_id] = {
            "template_key": template_key,
            "fields": dict(fields or {}),
            "created_at": datetime.utcnow(),
        }


_PENDING_TTL_SEC = 30 * 60  # незавершённый добор живёт 30 минут


def _get_pending(session_id: str) -> dict | None:
    with _pending_lock:
        p = _pending_docgen.get(session_id)
        if not p:
            return None
        created = p.get("created_at")
        if created and (datetime.utcnow() - created).total_seconds() > _PENDING_TTL_SEC:
            _pending_docgen.pop(session_id, None)
            return None
        return p


def _clear_pending(session_id: str) -> None:
    with _pending_lock:
        _pending_docgen.pop(session_id, None)


# Последний успешно сгенерированный документ в сессии — чтобы поддержать исправление
# полей ПОСЛЕ генерации («имя неправильно — должно быть …»). Извлечение дергаем только
# на сообщениях-исправлениях, поэтому лишних вызовов LLM нет.
_last_docgen: dict[str, dict] = {}


def _set_last_docgen(session_id: str, template_key: str, fields: dict) -> None:
    with _pending_lock:
        _last_docgen[session_id] = {
            "template_key": template_key,
            "fields": dict(fields or {}),
            "created_at": datetime.utcnow(),
        }


def _get_last_docgen(session_id: str) -> dict | None:
    with _pending_lock:
        p = _last_docgen.get(session_id)
        if not p:
            return None
        created = p.get("created_at")
        if created and (datetime.utcnow() - created).total_seconds() > _PENDING_TTL_SEC:
            _last_docgen.pop(session_id, None)
            return None
        return p


def _persist_and_finish(
    assistant_message_id: int,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    attach_doc_id: int | None = None,
    meta: dict | None = None,
) -> None:
    """Сохраняет текущий текст ответа в БД, помечает сообщение завершённым и будит SSE."""
    db = create_session()
    try:
        msg = db.get(ChatMessage, assistant_message_id)
        if msg:
            msg.content = state.content
            msg.is_finished = True
            msg.finished_at = datetime.utcnow()
            msg.last_seq = state.last_seq
            if attach_doc_id is not None:
                msg.attachment_document_id = attach_doc_id
            if meta:
                msg.meta = meta
            db.commit()
    finally:
        db.close()
    state.finished = True
    loop.call_soon_threadsafe(state.event.set)


# ---------------------------------------------------------------------------
# Worker-функция: запускается в фоновом потоке (LLM блокирует GIL слабо).
# ---------------------------------------------------------------------------


def _run_generation(
    session_id: str,
    user_text: str,
    assistant_message_id: int,
    dialogue_id: int,
    user_id: int,
    use_rag: bool,
    history: list[dict],
    attached_documents: list[dict],
    dialogue_summary: str | None,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    forwarded: bool = False,
    faq_id: int | None = None,
) -> None:
    from time import perf_counter

    pipeline = get_pipeline()
    t0 = perf_counter()
    last_stage_at = t0

    # ФИО и должность пользователя — чтобы модель знала, с кем общается.
    user_ctx = None
    _u_db = create_session()
    try:
        _u = _u_db.get(User, user_id)
        if _u:
            user_ctx = "Ты общаешься с сотрудником ТИУ: {}{}. Учитывай его роль в ответах.".format(
                _u.full_name, f", должность: {_u.position}" if _u.position else ""
            )
    finally:
        _u_db.close()

    logger.info(
        "[CHAT msg={}] >>> START | use_rag={}, history_msgs={}, attachments={}, summary={}, query_chars={}",
        assistant_message_id,
        use_rag,
        len(history or []),
        len(attached_documents or []),
        "yes" if dialogue_summary else "no",
        len(user_text or ""),
    )

    def _set_status(stage: str) -> None:
        nonlocal last_stage_at
        now = perf_counter()
        logger.info(
            "[CHAT msg={}] stage={} elapsed_total={:.2f}s delta={:.2f}s",
            assistant_message_id,
            stage,
            now - t0,
            now - last_stage_at,
        )
        last_stage_at = now
        state.status = stage
        loop.call_soon_threadsafe(state.event.set)

    # ───────── Быстрый набор FAQ: кнопки на /chat → чёткий курируемый ответ ─────────
    if faq_id is not None and _handle_faq_direct(
        faq_id, assistant_message_id, state, loop, _set_status,
    ):
        return

    # ───────────────────────────────────────────────────────────────
    # Ветка А0: диалоговый добор — есть незавершённый запрос на генерацию
    # документа для этой сессии? Тогда текущее сообщение — это ответ с
    # недостающими полями (или отмена / «как есть»).
    # ───────────────────────────────────────────────────────────────
    if not attached_documents:
        pending = _get_pending(session_id)
        if pending:
            _set_status("extract_fields")
            if _continue_docgen(
                pending, user_text, session_id, assistant_message_id, user_id,
                state, loop, _set_status, t0,
            ):
                return
        else:
            # Нет активного добора, но пользователь просит исправить только что
            # созданный документ («имя неправильно — должно быть …») → пересоздаём.
            last = _get_last_docgen(session_id)
            if last and wants_correction(user_text):
                _set_status("extract_fields")
                if _apply_correction(
                    last, user_text, session_id, assistant_message_id, user_id,
                    state, loop, _set_status, t0,
                ):
                    return
            # «Сгенерируй как есть» / «отмена» без активного оформления — контекст
            # добора потерян (напр., после перезапуска сервера). НЕ гоним в RAG
            # (иначе бессмысленный отказ «нет в базе»), а подсказываем начать заново.
            if wants_force_generate(user_text) or wants_cancel(user_text):
                _set_status("generate")
                state.append(
                    "Не вижу активного оформления документа — возможно, контекст "
                    "сбросился. Напишите заново, какой документ создать и на кого, "
                    "например: «оформи отпуск по беременности на Иванову Марию Андреевну»."
                )
                loop.call_soon_threadsafe(state.event.set)
                _persist_and_finish(assistant_message_id, state, loop)
                return

    # ───────────────────────────────────────────────────────────────
    # Ветка А: распознан запрос на ГЕНЕРАЦИЮ HR-документа по шаблону.
    # Активируется, только если в БД есть шаблоны и в запросе есть
    # триггерные слова («нанять», «оформить», «уволить», «отпуск», …).
    # ───────────────────────────────────────────────────────────────
    template = None
    # При пересланных сообщениях intent-детект не запускаем: триггер-слова в чужом
    # тексте («приказ», «отпуск») — не команда пользователя создать документ.
    # Опечатки исправляем для роутинга («сделай преказ» → триггер сработает);
    # извлечение полей дальше идёт по оригиналу (фамилии портить нельзя).
    from services.rag.intent_classifier import resolve_intent
    from services.rag.spellfix import correct_typos

    user_text_routed = correct_typos(user_text)

    # ───────── Ветка Б2: отчёт по ДПО из xlsx-выгрузки (вложение + запрос) ─────────
    if attached_documents and not forwarded:
        from services.documents.dpo_report import DPO_REQUEST_RE

        if DPO_REQUEST_RE.search(user_text_routed) and _handle_dpo_report(
            attached_documents, assistant_message_id, user_id, state, loop, _set_status,
        ):
            return

    # ───────── Ветка Б1: характеристика из ходатайства (вложение + запрос) ─────────
    if attached_documents and not forwarded:
        from services.documents.characteristic import CHARACTERISTIC_REQUEST_RE

        if CHARACTERISTIC_REQUEST_RE.search(user_text_routed) and _handle_characteristic(
            attached_documents, assistant_message_id, user_id, state, loop, _set_status,
        ):
            return

    # ───────── Ветка Б6: вакансия из должностной инструкции (вложение + запрос) ─────────
    if attached_documents and not forwarded:
        from services.documents.vacancy import VACANCY_REQUEST_RE

        if VACANCY_REQUEST_RE.search(user_text_routed) and _handle_vacancy(
            attached_documents, assistant_message_id, user_id, state, loop, _set_status,
        ):
            return

    # ───────── Ветки Б3/Б4/Б5/Б7/А10: инструменты по вложению + запросу ─────────
    if attached_documents and not forwarded and _handle_tool_request(
        user_text_routed, attached_documents, assistant_message_id, user_id,
        state, loop, _set_status,
    ):
        return
    # Контекстное намерение (эмбеддинги + LLM для пограничных случаев). Регэксп
    # остаётся страховкой (union): классификатор расширяет распознавание —
    # «набросай приказ» без триггер-слов теперь тоже команда на документ.
    intent = None
    if use_rag and not forwarded and not attached_documents:
        intent = resolve_intent(user_text_routed, history)
    wants_doc = intent == "doc_generate" or looks_like_doc_request(user_text_routed)
    if use_rag and not attached_documents and not forwarded and wants_doc:
        _set_status("intent")
        db_tmp = create_session()
        try:
            template = detect_template(db_tmp, user_text_routed)
        except Exception as e:
            logger.warning("intent detection failed: {}", e)
        finally:
            db_tmp.close()

    if template is not None:
        # Защита от ложных срабатываний: если ни одно поле шаблона не извлеклось —
        # это была не команда, а вопрос. Исключение — явное «сгенерируй как есть»:
        # тогда создаём документ с пустыми полями по прямой просьбе пользователя.
        _set_status("extract_fields")
        try:
            preview_fields = extract_fields(user_text, template)
        except Exception:
            preview_fields = {}
        filled_count = sum(1 for v in (preview_fields or {}).values() if v)
        force = wants_force_generate(user_text)
        if filled_count >= 1 or force:
            _handle_document_generation(
                template=template,
                user_text=user_text,
                assistant_message_id=assistant_message_id,
                user_id=user_id,
                session_id=session_id,
                preview_fields=preview_fields,
                state=state,
                loop=loop,
                set_status=_set_status,
                t0=t0,
                force=force,
            )
            return
        else:
            logger.info(
                "[CHAT msg={}] intent matched но полей не извлеклось — fallback на RAG",
                assistant_message_id,
            )

    t_first_chunk = None
    try:
        result = pipeline.answer_stream(
            user_text,
            history=history,
            use_rag=use_rag,
            attached_documents=attached_documents,
            dialogue_summary=dialogue_summary,
            on_status=_set_status,
            extra_context=user_ctx,
            # Для пересланного из мессенджера пустая выдача поиска — не повод для
            # шаблонного отказа «нет в базе»: отвечаем обычным чатом.
            allow_no_context_answer=forwarded,
            intent_hint=intent,
        )

        logger.info(
            "[CHAT msg={}] pipeline ready, sources={} | elapsed={:.2f}s",
            assistant_message_id,
            len(result.sources or []),
            perf_counter() - t0,
        )

        # Источники готовы ДО текста — публикуем сразу, чтобы фронт нумеровал ссылки
        # правильно уже во время стрима (без мелькания сырых номеров чанков).
        state.sources = result.sources or []
        loop.call_soon_threadsafe(state.event.set)

        for chunk in result.answer_stream:
            if state.cancelled:
                logger.info("[CHAT msg={}] cancelled by user", assistant_message_id)
                break
            if t_first_chunk is None:
                t_first_chunk = perf_counter()
                logger.info(
                    "[CHAT msg={}] FIRST CHUNK delivered | elapsed_from_send={:.2f}s",
                    assistant_message_id,
                    t_first_chunk - t0,
                )
            state.append(chunk)
            loop.call_soon_threadsafe(state.event.set)

        # Пост-обработка: дедуп повторов, чистка артефактов + гарантия инлайн-ссылок
        # [k] (модель часто пишет блок «Источники», но забывает ссылки в тексте).
        from services.rag.post_process import ensure_inline_citations, post_process_answer
        final_content = post_process_answer(state.content)
        if not state.cancelled and result.sources:
            final_content = ensure_inline_citations(final_content, result.context_texts)

        # Финальный коммит в БД
        db = create_session()
        try:
            msg = db.get(ChatMessage, assistant_message_id)
            if msg:
                msg.content = final_content
                msg.is_finished = True
                msg.finished_at = datetime.utcnow()
                msg.is_cancelled = state.cancelled
                msg.last_seq = state.last_seq
                msg.sources = result.sources
                msg.subqueries = result.used_subqueries or None
                # А3: контакт подразделения + А2: связанные бланки — в мету (футер ответа)
                meta = {}
                if result.contact:
                    meta["contact"] = result.contact
                if result.related_files:
                    meta["related_files"] = result.related_files
                msg.meta = meta or None
                db.commit()
        finally:
            db.close()

        # Фоновые задачи: self-check и обновление summary диалога
        if not state.cancelled and state.content.strip():
            threading.Thread(
                target=_post_generation_tasks,
                args=(
                    assistant_message_id, dialogue_id, user_text, state.content,
                    result.sources, result.context_texts,
                ),
                daemon=True,
            ).start()

        # Push-уведомление о завершении генерации (#16) — вместо поллинга на клиенте.
        try:
            from services import notify

            notify.publish(user_id, {
                "type": "generation_done",
                "session_id": session_id,
                "dialogue_id": dialogue_id,
                "message_id": assistant_message_id,
                "has_sources": bool(result.sources),
                "cancelled": bool(state.cancelled),
            })
        except Exception as e:
            logger.debug("notify generation_done failed: {}", e)

        t_end = perf_counter()
        decode_time = (t_end - t_first_chunk) if t_first_chunk else 0.0
        logger.info(
            "[CHAT msg={}] <<< DONE total={:.2f}s | prefill={:.2f}s decode={:.2f}s chunks={} ~{:.1f} t/s | answer_chars={}",
            assistant_message_id,
            t_end - t0,
            (t_first_chunk - t0) if t_first_chunk else 0.0,
            decode_time,
            state.last_seq,
            (state.last_seq / decode_time) if decode_time > 0 else 0.0,
            len(state.content),
        )
    except Exception as e:
        logger.exception("[CHAT msg={}] Ошибка генерации: {}", assistant_message_id, e)
        state.append(f"\n[Ошибка: {e}]")
    finally:
        state.finished = True
        loop.call_soon_threadsafe(state.event.set)


def _handle_dpo_report(
    attached_documents: list[dict],
    assistant_message_id: int,
    user_id: int,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
) -> bool:
    """Б2: пользователь прикрепил xlsx-выгрузку «ПК за год» и просит отчёт по ДПО.
    Все числа считаются детерминированно из таблицы (без LLM)."""
    from services.documents.dpo_report import create_dpo_report

    src = _attach_by_suffix(attached_documents, {".xlsx", ".xlsm"})
    if not src:
        # Вложение не табличное — подсказываем, но не гоним запрос в RAG.
        set_status("generate")
        state.append(
            "Для отчёта по ДПО прикрепите **xlsx-выгрузку** из 1С:ЗиК "
            "(Обучение → отчёт «ПК за период»). Прикреплённый файл не похож на таблицу — "
            "я работаю с исходными колонками, а не с текстом."
        )
        loop.call_soon_threadsafe(state.event.set)
        _persist_and_finish(assistant_message_id, state, loop)
        return True

    set_status("render_doc")
    db = create_session()
    try:
        user = db.get(User, user_id)
        if user is None:
            return False
        doc, text, stats = create_dpo_report(db, user, src["stored_path"])
    except Exception as e:
        logger.exception("[DPO] отчёт упал: {}", e)
        state.append(
            f"Не удалось сформировать отчёт по ДПО: {e}. Проверьте, что это выгрузка "
            "«ПК за период» из 1С:ЗиК (шапка с колонками «Физическое лицо», "
            "«Категория должности», «Вид образования» и т.д.)."
        )
        loop.call_soon_threadsafe(state.event.set)
        _persist_and_finish(assistant_message_id, state, loop)
        return True
    finally:
        db.close()

    set_status("generate")
    state.append(
        f"Отчёт по ДПО за {stats['year']} год готов: {stats['total_people']} работников, "
        f"{stats['total_programs']} программ, {stats['long_events']} мероприятий (от 16 ч).\n\n"
        f"{text}\n\nФайл доступен ниже для скачивания."
    )
    loop.call_soon_threadsafe(state.event.set)
    _persist_and_finish(assistant_message_id, state, loop, attach_doc_id=doc.id)
    logger.info("[CHAT msg={}] отчёт ДПО создан: doc={}", assistant_message_id, doc.id)
    return True


def _handle_characteristic(
    attached_documents: list[dict],
    assistant_message_id: int,
    user_id: int,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
) -> bool:
    """Б1: пользователь прикрепил ходатайство о награждении и просит характеристику.
    Возвращает True, если запрос обработан этой веткой (иначе — обычный поток:
    вложение не похоже на ходатайство, пусть RAG/чат объяснит, что нужно)."""
    from services.documents.characteristic import create_characteristic, parse_petition

    text = (attached_documents[0].get("content") or "").strip()
    if not text:
        return False

    set_status("extract_fields")
    try:
        fields = parse_petition(text)
    except Exception as e:
        logger.warning("[CHAR] parse_petition failed: {}", e)
        return False
    # Вложение не похоже на ходатайство — не перехватываем запрос.
    if not fields.get("fio") and not fields.get("achievements"):
        return False

    set_status("render_doc")
    db = create_session()
    try:
        user = db.get(User, user_id)
        if user is None:
            return False
        doc, char_text = create_characteristic(db, user, fields)
    except Exception as e:
        logger.exception("[CHAR] генерация характеристики упала: {}", e)
        state.append(
            "Не удалось сформировать характеристику по ходатайству: "
            f"{e}. Попробуйте карточку «Создать характеристику» на главной странице — "
            "там поля можно поправить вручную."
        )
        loop.call_soon_threadsafe(state.event.set)
        _persist_and_finish(assistant_message_id, state, loop)
        return True
    finally:
        db.close()

    set_status("generate")
    head_bits = [b for b in (fields.get("fio"), fields.get("award")) if b]
    head = "Характеристика по ходатайству сформирована"
    if head_bits:
        head += f" ({'; '.join(head_bits)})"
    state.append(f"{head}.\n\n{char_text}\n\nФайл доступен ниже для скачивания.")
    loop.call_soon_threadsafe(state.event.set)
    _persist_and_finish(assistant_message_id, state, loop, attach_doc_id=doc.id)
    logger.info("[CHAT msg={}] характеристика создана: doc={}", assistant_message_id, doc.id)
    return True


def _handle_vacancy(
    attached_documents: list[dict],
    assistant_message_id: int,
    user_id: int,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
) -> bool:
    """Б6: пользователь прикрепил должностную инструкцию и просит текст вакансии.
    Раздел 2 «Должностные обязанности» переписывается LLM в форму для job-сайтов."""
    from services.documents.vacancy import create_vacancy, extract_duties_section

    text = (attached_documents[0].get("content") or "").strip()
    if not text:
        return False
    # Вложение не похоже на должностную инструкцию — пусть обычный чат объяснит.
    if not extract_duties_section(text) and "должностн" not in text.lower():
        return False

    set_status("render_doc")
    db = create_session()
    try:
        user = db.get(User, user_id)
        if user is None:
            return False
        doc, vac_text, meta = create_vacancy(db, user, text)
    except Exception as e:
        logger.exception("[VACANCY] генерация вакансии упала: {}", e)
        state.append(
            f"Не удалось сформировать текст вакансии: {e}. Попробуйте карточку "
            "«Вакансия из инструкции» на главной странице."
        )
        loop.call_soon_threadsafe(state.event.set)
        _persist_and_finish(assistant_message_id, state, loop)
        return True
    finally:
        db.close()

    set_status("generate")
    head = "Текст вакансии готов"
    if meta.get("position"):
        head += f" ({meta['position']})"
    state.append(
        f"{head}.\n\n{vac_text}\n\nЗарплату, график и контакты добавьте перед публикацией. "
        "Файл доступен ниже для скачивания."
    )
    loop.call_soon_threadsafe(state.event.set)
    _persist_and_finish(assistant_message_id, state, loop, attach_doc_id=doc.id)
    logger.info("[CHAT msg={}] вакансия создана: doc={}", assistant_message_id, doc.id)
    return True


def _handle_faq_direct(
    faq_id: int,
    assistant_message_id: int,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
) -> bool:
    """Ответ по конкретной FAQ-записи БЕЗ LLM — точный курируемый текст отдела
    кадров + связанные документы; контакт подразделения уходит в мету (футер)."""
    from data.faq_entries import FAQEntry

    set_status("generate")
    db = create_session()
    try:
        entry = db.get(FAQEntry, faq_id)
        if not entry or not entry.is_active:
            return False
        parts = [entry.answer.strip()] if (entry.answer or "").strip() else []
        # У под-ветки общее вступление лежит в головной записи группы
        if entry.position > 0:
            head = (
                db.query(FAQEntry)
                .filter(FAQEntry.group_key == entry.group_key, FAQEntry.position == 0)
                .first()
            )
            if head and (head.answer or "").strip():
                parts.append(head.answer.strip())
        related_files: list[dict] = []
        if entry.doc_refs:
            parts.append("Связанные документы: " + "; ".join(entry.doc_refs))
            from services.rag.blank_forms import resolve_doc_refs
            related_files = resolve_doc_refs(list(entry.doc_refs))
        if not parts:
            parts = ["По этому вопросу пока нет текста ответа — обратитесь к контактному лицу."]
        contact = entry.contact
        if not contact and entry.position > 0:
            head = (
                db.query(FAQEntry)
                .filter(FAQEntry.group_key == entry.group_key, FAQEntry.position == 0)
                .first()
            )
            contact = head.contact if head else None
    finally:
        db.close()

    state.append("\n\n".join(parts))
    loop.call_soon_threadsafe(state.event.set)
    meta: dict = {"faq_id": faq_id}
    if contact:
        meta["contact"] = contact
    if related_files:
        meta["related_files"] = related_files
    _persist_and_finish(assistant_message_id, state, loop, meta=meta)
    logger.info("[CHAT msg={}] быстрый FAQ-ответ: entry={}", assistant_message_id, faq_id)
    return True


def _attach_by_suffix(attached_documents: list[dict], suffixes: set[str]) -> dict | None:
    """Первое вложение с сохранённым оригиналом нужного формата."""
    for a in attached_documents:
        name = a.get("filename") or a.get("stored_path") or ""
        if a.get("stored_path") and Path(name).suffix.lower() in suffixes:
            return a
    return None


def _finish_tool(
    assistant_message_id: int,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    text: str,
    attach_doc_id: int | None = None,
) -> bool:
    """Общий финиш инструментальных веток: текст + (опционально) вложение."""
    state.append(text)
    loop.call_soon_threadsafe(state.event.set)
    _persist_and_finish(assistant_message_id, state, loop, attach_doc_id=attach_doc_id)
    return True


def _handle_tool_request(
    user_text_routed: str,
    attached_documents: list[dict],
    assistant_message_id: int,
    user_id: int,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
) -> bool:
    """Инструменты главной страницы по чат-команде с вложением: единая схема
    процесса (А10), справка на работника (Б3), опись уволенных (Б4),
    объявление конкурса ППС (Б5), дубликаты инструкций ОТ (Б7).
    Возвращает True, если запрос обработан (в т.ч. подсказкой о нужном файле)."""
    from services.documents.dismissed_inventory import INVENTORY_REQUEST_RE
    from services.documents.employee_certificate import CERTIFICATE_EMP_REQUEST_RE
    from services.documents.ot_dedup import OT_DEDUP_REQUEST_RE
    from services.documents.pps_announcement import PPS_REQUEST_RE
    from services.processes import PROCESS_REQUEST_RE

    xl = {".xls", ".xlsx", ".xlsm"}
    tools = [
        (OT_DEDUP_REQUEST_RE, _tool_ot_dedup, {".zip"},
         "Прикрепите **ZIP-архив** с инструкциями (docx/doc/pdf/rtf/txt) — я сравню тексты и найду однотипные."),
        (INVENTORY_REQUEST_RE, _tool_inventory, xl,
         "Для описи прикрепите **отчёт «Принято уволено»** из 1С:ЗиК (xls/xlsx)."),
        (CERTIFICATE_EMP_REQUEST_RE, _tool_certificate, xl,
         "Для справки прикрепите **выгрузку «Справка на сотрудника»** из 1С:ЗиК (xls/xlsx)."),
        (PPS_REQUEST_RE, _tool_pps, xl,
         "Для объявления прикрепите **выгрузки «Форма 2»** из 1С:ЗиК (xls/xlsx, по одному файлу на должность)."),
        (PROCESS_REQUEST_RE, _tool_process_schema,
         {".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xlsm", ".xls"},
         "Для единой схемы прикрепите файл со схемой процесса из Word, Excel или PowerPoint."),
    ]
    for rx, handler, suffixes, hint in tools:
        if not rx.search(user_text_routed):
            continue
        src = _attach_by_suffix(attached_documents, suffixes)
        if not src:
            set_status("generate")
            return _finish_tool(assistant_message_id, state, loop, hint)
        set_status("render_doc")
        db = create_session()
        try:
            user = db.get(User, user_id)
            if user is None:
                return False
            return handler(db, user, src, attached_documents, assistant_message_id, state, loop)
        except Exception as e:
            logger.exception("[TOOL] инструментальная ветка упала: {}", e)
            return _finish_tool(
                assistant_message_id, state, loop,
                f"Не удалось выполнить операцию: {e}. Попробуйте одноимённую карточку на главной странице.",
            )
        finally:
            db.close()
    return False


def _tool_certificate(db, user, src, attached, assistant_message_id, state, loop) -> bool:
    from services.documents.employee_certificate import create_certificate

    doc, fields = create_certificate(db, user, src["stored_path"])
    pk = fields.get("Повышение квалификации")
    work = fields.get("Работа по окончании ВУЗа")
    bits = []
    if isinstance(pk, list):
        bits.append(f"повышение квалификации — {len(pk)} записей за последние 3 года")
    if isinstance(work, list):
        bits.append(f"работа по должностям — {len(work)} строк без дублей приказов")
    return _finish_tool(
        assistant_message_id, state, loop,
        f"Справка преобразована в читабельный вид ({'; '.join(bits) or 'готово'}). "
        "Файл доступен ниже для скачивания.",
        attach_doc_id=doc.id,
    )


def _tool_inventory(db, user, src, attached, assistant_message_id, state, loop) -> bool:
    from services.documents.dismissed_inventory import create_inventory

    doc, result = create_inventory(db, user, src["stored_path"])
    return _finish_tool(
        assistant_message_id, state, loop,
        f"Опись сформирована: в неё попали {len(result['items'])} из {result['fired_total']} "
        f"уволенных в {result['year']} году (категории АУП/АХП/УВП, повторно принятые "
        f"исключены: {result['skipped_rehired']}). Даты увольнения — «дата записи» минус "
        "один день. Файл xlsx доступен ниже.",
        attach_doc_id=doc.id,
    )


def _tool_pps(db, user, src, attached, assistant_message_id, state, loop) -> bool:
    from services.documents.pps_announcement import create_announcement

    xl = {".xls", ".xlsx", ".xlsm"}
    paths = [
        a["stored_path"] for a in attached
        if a.get("stored_path") and Path(a.get("filename") or a["stored_path"]).suffix.lower() in xl
    ]
    doc, data = create_announcement(db, user, paths)
    return _finish_tool(
        assistant_message_id, state, loop,
        f"Объявление о выборах и конкурсе ППС от {data['date']} готово: "
        f"{data['positions']} должностей, {data['departments']} кафедр, "
        f"{data['people']} работников в выгрузках. Требования в скобках — черновик из "
        "данных переизбираемых, отредактируйте перед публикацией. Файл доступен ниже.",
        attach_doc_id=doc.id,
    )


def _tool_ot_dedup(db, user, src, attached, assistant_message_id, state, loop) -> bool:
    from services.documents.ot_dedup import run_dedup_zip

    doc, result = run_dedup_zip(db, user, src["stored_path"])
    top = result["pairs"][:5]
    lines = "\n".join(f"- {p['a']} ↔ {p['b']} — {p['percent']}%" for p in top)
    return _finish_tool(
        assistant_message_id, state, loop,
        f"Сравнил {result['files']} инструкций: пар с совпадением ≥80% — "
        f"{result['duplicates']}, групп однотипных — {len(result['groups'])}."
        + (f"\n\nСамые похожие:\n{lines}" if lines else "")
        + "\n\nПолный xlsx-отчёт доступен ниже.",
        attach_doc_id=doc.id,
    )


def _tool_process_schema(db, user, src, attached, assistant_message_id, state, loop) -> bool:
    import re as _re

    from data.my_documents import MyDocuments
    from services.processes import extract_process_graph, render_process_svg

    graph = extract_process_graph(src["stored_path"])
    if graph is None:
        return _finish_tool(
            assistant_message_id, state, loop,
            "Не удалось распознать схему: в файле нет блоков со стрелками. Если схема — "
            "картинка или скан, векторно преобразовать её нельзя.",
        )
    if not graph.title:
        stem = Path(src.get("filename") or "схема").stem
        stem = _re.sub(r"\s*ИИ\s*$", "", stem.lstrip("!_ ")).strip()
        graph.title = (stem[:1].upper() + stem[1:]) if stem else None
    svg = render_process_svg(graph)
    settings.docs_generated.mkdir(parents=True, exist_ok=True)
    out = settings.docs_generated / f"schema_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.svg"
    out.write_text(svg, encoding="utf-8")
    rec = MyDocuments(
        user_id=user.id,
        title=f"Единая схема: {graph.title}" if graph.title else "Единая схема процесса",
        template_key="process_schema",
        file_path=str(out),
        progress=100,
        status="ready",
        fields={"nodes": len(graph.nodes), "edges": len(graph.edges)},
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return _finish_tool(
        assistant_message_id, state, loop,
        f"Схема перерисована в едином стиле ТИУ: {len(graph.nodes)} блоков, "
        f"{len(graph.edges)} переходов, {sum(1 for n in graph.nodes if n.role)} ролей. "
        "SVG-файл доступен ниже (открывается в браузере, вставляется в Word).",
        attach_doc_id=rec.id,
    )


def _docgen_ask_missing(
    template,
    fields: dict,
    missing: list[str],
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
    assistant_message_id: int,
    session_id: str,
) -> None:
    """Просит у пользователя недостающие обязательные поля и запоминает контекст
    (шаблон + уже собранные значения) для диалогового добора.
    `missing` — список ИМЁН полей; подписи для показа переводим на русский."""
    set_status("generate")
    schema = {f.get("name"): f for f in (template.fields_schema or []) if f.get("name")}

    def _label(n: str) -> str:
        return ru_field_label(n, (schema.get(n) or {}).get("label"))

    known = {
        _label(n): fields.get(n)
        for n in schema
        if fields.get(n) not in (None, "")
    }
    lines = [f"Чтобы оформить «{template.title}», не хватает данных:"]
    lines += [f"- {_label(n)}" for n in missing]
    if known:
        lines.append("")
        lines.append("Уже распознано:")
        lines += [f"- {k}: {v}" for k, v in known.items()]
    lines.append("")
    lines.append(
        "Напишите недостающие сведения — можно по одному сообщению или все сразу. "
        "Можно и исправить уже распознанное (например, «отчество должно быть Алексеевна»). "
        "Если нужно оформить без недостающих полей, напишите «сгенерируй как есть»."
    )
    state.append("\n".join(lines))
    loop.call_soon_threadsafe(state.event.set)

    _set_pending(session_id, template.key, fields)
    logger.info(
        "[CHAT msg={}] doc-gen: не хватает полей {} — запрошены (pending для session)",
        assistant_message_id,
        missing,
    )
    _persist_and_finish(assistant_message_id, state, loop)


def _docgen_render_and_reply(
    template,
    fields: dict,
    user_id: int,
    assistant_message_id: int,
    session_id: str,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
    t0: float,
) -> None:
    """Рендерит .docx по собранным полям, привязывает к сообщению и стримит
    короткое подтверждение."""
    from time import perf_counter

    set_status("render_doc")
    doc_id: int | None = None
    doc_title = summarize_for_title(template, fields)
    try:
        db = create_session()
        try:
            from data.users import User

            user = db.get(User, user_id)
            if user is None:
                raise RuntimeError("user not found")
            doc = generate_document(db, user, template.key, fields, title=doc_title)
            doc_id = doc.id
        finally:
            db.close()
    except Exception as e:
        logger.exception("doc render failed: {}", e)
        state.append(f"Не удалось сгенерировать документ: {e}")
        loop.call_soon_threadsafe(state.event.set)
        _persist_and_finish(assistant_message_id, state, loop)
        return

    # Готовим короткое подтверждение через LLM (стримим, чтобы UX оставался живым).
    set_status("generate")
    used_fields = {k: v for k, v in fields.items() if v}
    user_msg = (
        f"Создан документ «{template.title}».\n"
        f"Заполненные поля: {json.dumps(used_fields, ensure_ascii=False)}\n\n"
        "Сообщи это HR-специалисту."
    )
    try:
        llm = get_llm()
        first_chunk = True
        for chunk in llm.chat_stream(
            system=SYSTEM_PROMPT_DOC_REPLY, user=user_msg, max_tokens=180
        ):
            if state.cancelled:
                break
            if first_chunk:
                logger.info(
                    "[CHAT msg={}] doc-gen first chunk delivered | elapsed={:.2f}s",
                    assistant_message_id,
                    perf_counter() - t0,
                )
                first_chunk = False
            state.append(chunk)
            loop.call_soon_threadsafe(state.event.set)
    except Exception as e:
        logger.warning("doc reply stream failed: {}", e)
        state.append(f"\nДокумент «{template.title}» сохранён. Файл доступен ниже.")

    _persist_and_finish(assistant_message_id, state, loop, attach_doc_id=doc_id)
    # Запоминаем последний документ сессии — для исправления полей после генерации.
    _set_last_docgen(session_id, template.key, fields)
    logger.info(
        "[CHAT msg={}] doc-gen DONE total={:.2f}s | document_id={}",
        assistant_message_id,
        perf_counter() - t0,
        doc_id,
    )


def _handle_document_generation(
    template,
    user_text: str,
    assistant_message_id: int,
    user_id: int,
    session_id: str,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
    t0: float,
    preview_fields: dict | None = None,
    force: bool = False,
) -> None:
    """Первичная обработка запроса «оформи приказ», «нанять X» и т.п.
    Извлекает поля; если не хватает обязательных и пользователь не просил «как есть»
    — запрашивает недостающее (диалоговый добор), иначе рендерит документ."""
    from time import perf_counter

    fields: dict = preview_fields if preview_fields is not None else {}
    try:
        if not fields:
            fields = extract_fields(user_text, template) or {}
        fields = fill_defaults(fields, template)
        # Числовые поля приводим к числу и отбрасываем мусор («пельмени» в оклад).
        fields = validate_fields(fields, template)
    except Exception as e:
        logger.warning("extract_fields failed: {}", e)

    logger.info(
        "[CHAT msg={}] doc-gen: template='{}', fields_extracted={}, force={}, elapsed={:.2f}s",
        assistant_message_id,
        template.key,
        sum(1 for v in fields.values() if v),
        force,
        perf_counter() - t0,
    )

    missing = missing_required_fields(fields, template)
    if missing and not force:
        _docgen_ask_missing(
            template, fields, missing, state, loop, set_status,
            assistant_message_id, session_id,
        )
        return

    _clear_pending(session_id)
    _docgen_render_and_reply(
        template, fields, user_id, assistant_message_id, session_id, state, loop, set_status, t0
    )


def _continue_docgen(
    pending: dict,
    user_text: str,
    session_id: str,
    assistant_message_id: int,
    user_id: int,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
    t0: float,
) -> bool:
    """Продолжение диалогового добора: пользователь досказывает поля для начатой
    генерации. Возвращает True, если сообщение обработано как продолжение (запрос
    ещё полей / генерация / отмена); False — если пользователь сменил тему (тогда
    pending снят и сообщение уходит в обычный поток)."""
    from data.doc_templates import DocTemplate

    db_tmp = create_session()
    try:
        template = (
            db_tmp.query(DocTemplate)
            .filter(DocTemplate.key == pending.get("template_key"))
            .first()
        )
    finally:
        db_tmp.close()
    if template is None:
        _clear_pending(session_id)
        return False

    # Явная отмена начатого оформления.
    if wants_cancel(user_text):
        _clear_pending(session_id)
        set_status("generate")
        state.append(f"Хорошо, отменил оформление «{template.title}».")
        loop.call_soon_threadsafe(state.event.set)
        _persist_and_finish(assistant_message_id, state, loop)
        return True

    force = wants_force_generate(user_text)
    is_correction = wants_correction(user_text)

    prior = dict(pending.get("fields") or {})
    # Контекст для извлечения: что уже есть и чего не хватает — чтобы одиночные
    # значения без подписи («Александровна», «лаборант») сопоставились с нужными
    # полями по смыслу, а не потерялись.
    schema = {f.get("name"): f for f in (template.fields_schema or []) if f.get("name")}

    def _label(n: str) -> str:
        return ru_field_label(n, (schema.get(n) or {}).get("label"))

    known_desc = ", ".join(
        f"{_label(k)}={v}" for k, v in prior.items() if v not in (None, "")
    ) or "—"
    missing_desc = ", ".join(
        f"{_label(n)} ({n})" for n in missing_required_fields(prior, template)
    ) or "—"
    context = (
        f"Уже заполнено: {known_desc}.\n"
        f"Ещё не хватает: {missing_desc}.\n"
        "Пользователь досказывает недостающие поля или исправляет ранее указанные. "
        "Сопоставляйте одиночные значения без подписи с недостающими полями по смыслу: "
        "отчество обычно оканчивается на «-овна/-евна/-ична/-ович/-евич»; "
        "должность — существительное-профессия (лаборант, инженер). "
        "Заполняйте только те поля, значения которых явно есть в сообщении."
    )

    try:
        new_fields = validate_fields(
            extract_fields(user_text, template, context=context) or {}, template
        )
    except Exception as e:
        logger.warning("continue-docgen extract failed: {}", e)
        new_fields = {}

    merged = dict(prior)
    got_new = False
    for k, v in new_fields.items():
        if v in (None, ""):
            continue
        cur = merged.get(k)
        if cur in (None, ""):
            merged[k] = v  # заполняем пустой слот
            got_new = True
        elif is_correction and str(v).strip() != str(cur).strip():
            merged[k] = v  # исправление ранее заполненного поля
            got_new = True

    # Fallback: LLM не распознала значение (например, «HR-служба» как подразделение),
    # но не хватает РОВНО ОДНОГО поля и пользователь прислал обычное значение (не
    # вопрос/команда) → это и есть ответ на наш вопрос. Кладём текст прямо в поле.
    if not got_new and not force and not is_correction:
        missing_now = missing_required_fields(prior, template)
        cleaned = (user_text or "").strip()
        if (
            len(missing_now) == 1
            and cleaned
            and len(cleaned) <= 120
            and "?" not in cleaned
            and not wants_cancel(cleaned)
        ):
            merged[missing_now[0]] = cleaned
            got_new = True
            logger.info(
                "[CHAT msg={}] doc-gen: сырое значение '{}' → единственное недостающее поле '{}'",
                assistant_message_id, cleaned[:40], missing_now[0],
            )

    # Ни одного поля не заполнил/не исправил и не просит «как есть» → он сменил
    # тему: снимаем pending и отдаём сообщение обычному потоку (RAG/чат).
    if not got_new and not force:
        _clear_pending(session_id)
        logger.info(
            "[CHAT msg={}] doc-gen: ответ не содержит недостающих полей — pending снят, обычный поток",
            assistant_message_id,
        )
        return False

    merged = fill_defaults(merged, template)
    missing = missing_required_fields(merged, template)
    if missing and not force:
        _docgen_ask_missing(
            template, merged, missing, state, loop, set_status,
            assistant_message_id, session_id,
        )
        return True

    _clear_pending(session_id)
    _docgen_render_and_reply(
        template, merged, user_id, assistant_message_id, session_id, state, loop, set_status, t0
    )
    return True


def _apply_correction(
    last: dict,
    user_text: str,
    session_id: str,
    assistant_message_id: int,
    user_id: int,
    state: StreamState,
    loop: asyncio.AbstractEventLoop,
    set_status,
    t0: float,
) -> bool:
    """Исправление полей ПОСЛЕ генерации: «имя неправильно — должно быть …».
    Перегенерирует документ с исправленными значениями. Возвращает True, если
    что-то реально изменилось и документ пересоздан."""
    from data.doc_templates import DocTemplate

    db_tmp = create_session()
    try:
        template = (
            db_tmp.query(DocTemplate)
            .filter(DocTemplate.key == last.get("template_key"))
            .first()
        )
    finally:
        db_tmp.close()
    if template is None:
        return False

    prior = dict(last.get("fields") or {})
    schema = {f.get("name"): f for f in (template.fields_schema or []) if f.get("name")}

    def _label(n: str) -> str:
        return ru_field_label(n, (schema.get(n) or {}).get("label"))

    known_desc = ", ".join(
        f"{_label(k)}={v}" for k, v in prior.items() if v not in (None, "")
    ) or "—"
    context = (
        f"Ранее оформлен документ со значениями: {known_desc}.\n"
        "Пользователь просит ИСПРАВИТЬ одно или несколько полей. Верните ТОЛЬКО те "
        "поля, для которых в сообщении указано новое значение (остальные — null)."
    )
    try:
        new_fields = validate_fields(
            extract_fields(user_text, template, context=context) or {}, template
        )
    except Exception as e:
        logger.warning("correction extract failed: {}", e)
        new_fields = {}

    merged = dict(prior)
    changed = False
    for k, v in new_fields.items():
        if v in (None, ""):
            continue
        if str(v).strip() != str(merged.get(k) or "").strip():
            merged[k] = v
            changed = True
    if not changed:
        return False

    merged = fill_defaults(merged, template)
    logger.info(
        "[CHAT msg={}] doc-gen correction → перегенерация '{}'",
        assistant_message_id, template.key,
    )
    _docgen_render_and_reply(
        template, merged, user_id, assistant_message_id, session_id, state, loop, set_status, t0
    )
    return True


def _collect_history_before(
    db: Session, session_id: str, before_id: int, limit: int = 6
) -> list[dict]:
    """История сообщений ДО указанного (для ретрая — контекст до перегенерируемого
    вопроса). Берём только активные варианты ассистента, чтобы не смешивать ветки."""
    msgs = (
        db.query(ChatMessage)
        .filter(
            ChatMessage.session_id == session_id,
            ChatMessage.is_finished == True,  # noqa: E712
            ChatMessage.id < before_id,
            ChatMessage.role.in_(("user", "assistant")),
        )
        .order_by(ChatMessage.id.desc())
        .limit(limit * 2)
        .all()
    )
    msgs = list(reversed(msgs))
    return [
        {"role": m.role, "content": _history_entry_content(m)}
        for m in msgs
        if m.role == "user" or m.variant_active
    ]


def _post_generation_tasks(
    assistant_message_id: int,
    dialogue_id: int,
    user_query: str,
    answer: str,
    sources: list[dict] | None,
    context_texts: list[str] | None = None,
) -> None:
    """Фоновый job после завершения генерации:
    1) self-check (если включён и есть источники) — пишет в ChatMessage.fact_check
    2) summary диалога, если число сообщений превысило порог

    Между завершением стрима и фоном даём 3 секунды — за это время
    клиент дёргает /auto-title, и он успевает встать в очередь LLM первым.
    """
    import time as _time
    _time.sleep(3)

    pipeline = get_pipeline()

    # 0) Авто-название диалога — НА СЕРВЕРЕ, не завися от клиента (работает, даже если
    # пользователь ушёл со страницы). _auto_title_worker сам не трогает имя, заданное
    # пользователем вручную (guard по title != DEFAULT_TITLE).
    try:
        from routes.dialogues import _auto_title_worker
        _db = create_session()
        try:
            _dlg = _db.get(Dialogue, dialogue_id)
            _uid = _dlg.user_id if _dlg else None
        finally:
            _db.close()
        if _uid:
            _auto_title_worker(dialogue_id, _uid)
    except Exception as e:
        logger.warning("[post-gen] auto-title failed: {}", e)

    # 1) Self-check: сверяем ответ с текстами чанков, которые реально были в контексте.
    if settings.rag_use_self_check and sources:
        try:
            db = create_session()
            try:
                src_texts = [t for t in (context_texts or []) if t.strip()][:3]
                if src_texts:
                    fact = pipeline.self_check(user_query, answer, src_texts)
                    if fact:
                        msg = db.get(ChatMessage, assistant_message_id)
                        if msg:
                            # Сохраняем только результат для UI-бейджа; текст-предупреждение
                            # в контент НЕ дописываем — бейджа «Не подкреплено (0/N)» достаточно.
                            msg.fact_check = fact
                            supported = int(fact.get("supported") or 0)
                            total = int(fact.get("total") or 0)
                            db.commit()
                            logger.info(
                                "[CHAT msg={}] self-check: {}/{} supported, {} issues",
                                assistant_message_id,
                                supported,
                                total,
                                len(fact.get("issues") or []),
                            )
            finally:
                db.close()
        except Exception as e:
            logger.warning("self-check failed: {}", e)

    # 2) Conversational summary
    try:
        db = create_session()
        try:
            dialogue = db.get(Dialogue, dialogue_id)
            if not dialogue:
                return
            # Соберём все finished-сообщения диалога
            all_msgs = (
                db.query(ChatMessage)
                .join(ChatSession, ChatMessage.session_id == ChatSession.id)
                .filter(
                    ChatSession.dialogue_id == dialogue_id,
                    ChatMessage.is_finished == True,  # noqa: E712
                    # Только активные варианты ответа (не дублируем ветки ретрая).
                    or_(ChatMessage.role != "assistant", ChatMessage.variant_active == True),  # noqa: E712
                )
                .order_by(ChatMessage.id.asc())
                .all()
            )
            if len(all_msgs) < settings.rag_memory_after_messages:
                return
            # Если новых сообщений после последней свёртки меньше двух — не пересчитываем
            new_msgs = [m for m in all_msgs if m.id > (dialogue.memory_covers_up_to or 0)]
            if len(new_msgs) < 2:
                return

            # Сводка покрывает всё, КРОМЕ последних N (последние оставляем «как есть» в истории).
            keep_recent = settings.rag_memory_recent_keep * 2  # user+assistant пары
            to_summarize = all_msgs[:-keep_recent] if keep_recent > 0 else all_msgs
            if not to_summarize:
                return

            summary = pipeline.summarize_history(
                [{"role": m.role, "content": m.content} for m in to_summarize]
            )
            if summary:
                dialogue.memory_summary = summary
                dialogue.memory_covers_up_to = to_summarize[-1].id
                db.commit()
                logger.info(
                    "[DIALOGUE {}] summary refreshed ({} chars, covers {} messages)",
                    dialogue_id,
                    len(summary),
                    len(to_summarize),
                )
        finally:
            db.close()
    except Exception as e:
        logger.warning("summary update failed: {}", e)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _message_item(db: Session, m: ChatMessage, user: User) -> dict:
    """Сериализация одного сообщения для клиента (без полей вариантов — их
    добавляет list_messages для активного варианта группы)."""
    item = {
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "is_read": m.is_read,
        "is_finished": m.is_finished,
        "created_at": _utc_iso(m.created_at),
        "finished_at": _utc_iso(m.finished_at),
        # Время для показа: у ассистента — конец генерации, у пользователя — отправка.
        "ts": _utc_iso(m.finished_at or m.created_at) if m.role == "assistant" else _utc_iso(m.created_at),
        "sources": m.sources,
        "meta": m.meta if m.role == "assistant" else None,
        "fact_check": m.fact_check if m.role == "assistant" else None,
        # Пересланные из мессенджера сообщения (только у сообщений пользователя)
        "forwarded": m.forwarded_meta if m.role == "user" and m.forwarded_meta else None,
    }
    if m.attachment_document_id:
        from data.my_documents import MyDocuments
        doc = db.get(MyDocuments, m.attachment_document_id)
        if doc:
            item["attachment"] = {
                "id": doc.id,
                "title": doc.title,
                "filename": Path(doc.file_path).name if doc.file_path else None,
                "template_key": doc.template_key,
            }
    if m.role == "user":
        ups = (
            db.query(SessionDocument)
            .filter(SessionDocument.message_id == m.id)
            .order_by(SessionDocument.id.asc())
            .all()
        )
        if ups:
            item["user_attachments"] = [{"id": u.id, "name": u.filename} for u in ups]
    if m.role == "assistant":
        fb = (
            db.query(ChatFeedback)
            .filter(ChatFeedback.message_id == m.id, ChatFeedback.user_id == user.id)
            .first()
        )
        item["user_rating"] = fb.rating if fb else 0
    return item


@router.get("/messages")
async def list_messages(
    session_id: str = Query(...),
    mark_as_read: bool = Query(default=False),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    s = db.get(ChatSession, session_id)
    if not s or s.dialogue.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")

    msgs = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.id.asc())
        .all()
    )
    # Ветвление как в ChatGPT: показываем только активную ветку дерева диалога
    # (неактивные варианты и всё их продолжение скрыты — см. _hidden_message_ids).
    from collections import defaultdict

    user_groups: dict[int, list] = defaultdict(list)
    asst_groups: dict[int, list] = defaultdict(list)
    for m in msgs:
        (user_groups if m.role == "user" else asst_groups)[m.variant_group or m.id].append(m)

    hidden = _hidden_message_ids(msgs)

    out = []
    for m in msgs:
        if m.id in hidden:
            continue
        grp = (user_groups if m.role == "user" else asst_groups)[m.variant_group or m.id]
        item = _message_item(db, m, user)
        if len(grp) > 1:
            item["variant_group"] = m.variant_group or m.id
            item["variant_index"] = [v.id for v in grp].index(m.id) + 1
            item["variant_count"] = len(grp)
        out.append(item)

    unread = sum(
        1 for m in msgs
        if m.role == "assistant" and not m.is_read and m.id not in hidden
    )
    if mark_as_read and unread:
        for m in msgs:
            if m.role == "assistant" and not m.is_read:
                m.is_read = True
        db.commit()
        try:
            from services import notify
            notify.publish(user.id, {"type": "unread_changed", "scope": "ai"})
        except Exception:
            pass
    return {
        "success": True,
        "messages": out,
        "unread_count": unread,
        # Пересланные из мессенджера сообщения, ожидающие первой отправки
        "pending_forward": s.dialogue.pending_forward or None,
    }


def _variant_list(db: Session, session_id: str, group: int, role: str) -> list[ChatMessage]:
    return (
        db.query(ChatMessage)
        .filter(
            ChatMessage.session_id == session_id,
            ChatMessage.variant_group == group,
            ChatMessage.role == role,
        )
        .order_by(ChatMessage.id.asc())
        .all()
    )


@router.post("/variant")
async def switch_variant(
    body: VariantSwitchRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Переключение между вариантами: у ответа ассистента (‹ i/n ›) — точечная замена
    пузыря; у сообщения пользователя (ветки правок) — переключение всей ветки
    (фронт перезагружает сообщения)."""
    s = db.get(ChatSession, body.session_id)
    if not s or s.dialogue.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")
    cur = db.get(ChatMessage, body.message_id)
    if not cur or cur.session_id != s.id or cur.role not in ("assistant", "user"):
        raise HTTPException(404, "Сообщение не найдено")

    group = cur.variant_group or cur.id
    variants = _variant_list(db, s.id, group, cur.role) or [cur]
    idx = next((i for i, v in enumerate(variants) if v.id == cur.id), 0)
    new_idx = max(0, min(idx + (body.direction or 0), len(variants) - 1))
    target = variants[new_idx]

    for v in variants:
        v.variant_active = (v.id == target.id)
    db.commit()

    # Для пользовательской ветки меняется весь ход разговора → фронт перезагрузит список.
    if cur.role == "user":
        return {"success": True, "role": "user", "reload": True}

    # У вариантов ответа тоже могут быть «продолжения» (вопросы, заданные после
    # старого варианта до ретрая) — тогда переключение меняет видимую ветку целиком
    # и точечной замены пузыря недостаточно.
    group_ids = {v.id for v in variants}
    has_branch_content = any(
        row.id not in group_ids
        for row in db.query(ChatMessage.id)
        .filter(ChatMessage.session_id == s.id, ChatMessage.id > variants[0].id)
        .all()
    )
    if has_branch_content:
        return {"success": True, "role": "assistant", "reload": True}

    item = _message_item(db, target, user)
    item["variant_group"] = group
    item["variant_index"] = new_idx + 1
    item["variant_count"] = len(variants)
    return {"success": True, "role": "assistant", "message": item}


@router.post("/edit")
async def edit_message(
    body: EditMessageRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Правка сообщения пользователя → НОВАЯ ветка: создаём новый вариант вопроса
    и заново генерируем ответ. Возвращает id ответа для подписки на стрим."""
    s = db.get(ChatSession, body.session_id)
    if not s or s.dialogue.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")
    orig = db.get(ChatMessage, body.message_id)
    if not orig or orig.session_id != s.id or orig.role != "user":
        raise HTTPException(404, "Сообщение не найдено")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Пустой текст сообщения")

    if orig.variant_group is None:
        orig.variant_group = orig.id
    group = orig.variant_group

    # Новый вариант вопроса активен, прежние — нет.
    db.query(ChatMessage).filter(
        ChatMessage.variant_group == group, ChatMessage.role == "user"
    ).update({ChatMessage.variant_active: False}, synchronize_session=False)

    new_user = ChatMessage(
        session_id=s.id, role="user", content=text,
        is_read=True, is_finished=True,
        variant_group=group, variant_active=True,
        # Пересланный блок и якорь ветки принадлежат вопросу — наследуются вариантом.
        forwarded_meta=orig.forwarded_meta,
        branch_of=orig.branch_of,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    assistant_msg = ChatMessage(
        session_id=s.id, role="assistant", content="",
        is_read=False, is_finished=False,
        variant_group=None, variant_active=True, reply_to=new_user.id,
    )
    db.add(assistant_msg)
    db.commit()
    db.refresh(assistant_msg)
    assistant_msg.variant_group = assistant_msg.id
    db.commit()

    s.dialogue.last_activity = datetime.utcnow()
    db.commit()

    # Контекст — сообщения до исходного вопроса (активная ветка).
    history = _collect_history_before(db, s.id, orig.id, limit=settings.rag_memory_recent_keep)
    # Вложения исходного вопроса переиспользуем как контекст.
    att_docs = (
        db.query(SessionDocument)
        .filter(SessionDocument.message_id == orig.id)
        .order_by(SessionDocument.id.asc())
        .all()
    )
    attached_documents = [
        {"id": d.id, "filename": d.filename, "content": d.content, "stored_path": d.stored_path}
        for d in att_docs
    ]

    gen_text, use_rag_flag, forwarded = _gen_text_for_user_message(
        text, orig.forwarded_meta, True
    )

    loop = asyncio.get_running_loop()
    state = StreamState(
        session_id=s.id, message_id=assistant_msg.id, started_at=datetime.utcnow()
    )
    _register_stream(state)
    threading.Thread(
        target=_run_generation,
        args=(
            s.id, gen_text, assistant_msg.id, s.dialogue.id, s.dialogue.user_id,
            use_rag_flag, history, attached_documents, s.dialogue.memory_summary,
            state, loop, forwarded,
        ),
        daemon=True,
    ).start()

    return {"success": True, "assistant_message_id": assistant_msg.id}


@router.post("/feedback")
async def post_feedback(
    body: dict,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Сохраняем реакцию пользователя на ответ ассистента (✓ / ✗ / отмена)."""
    msg_id = body.get("message_id")
    rating = body.get("rating")
    if not isinstance(msg_id, int):
        raise HTTPException(400, "message_id обязателен")
    msg = db.get(ChatMessage, msg_id)
    if not msg or msg.role != "assistant":
        raise HTTPException(404, "Сообщение не найдено")
    # Проверка владельца через сессию диалога
    if msg.session.dialogue.user_id != user.id:
        raise HTTPException(403, "Нет доступа к сообщению")

    existing = (
        db.query(ChatFeedback)
        .filter(ChatFeedback.message_id == msg_id, ChatFeedback.user_id == user.id)
        .first()
    )
    if rating in (0, None):
        if existing:
            db.delete(existing)
            db.commit()
        return {"success": True, "rating": 0}
    if rating not in (1, -1):
        raise HTTPException(400, "rating должен быть 1, -1 или 0")
    if existing:
        existing.rating = rating
        existing.comment = body.get("comment") or None
    else:
        db.add(ChatFeedback(
            message_id=msg_id, user_id=user.id,
            rating=rating, comment=body.get("comment") or None,
        ))
    db.commit()
    return {"success": True, "rating": rating}


@router.post("/mark-as-read")
async def mark_as_read(
    body: MarkReadRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    s = db.get(ChatSession, body.session_id)
    if not s or s.dialogue.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")
    if body.message_ids:
        (
            db.query(ChatMessage)
            .filter(
                ChatMessage.session_id == body.session_id,
                ChatMessage.id.in_(body.message_ids),
            )
            .update({ChatMessage.is_read: True}, synchronize_session=False)
        )
        db.commit()
        try:
            from services import notify
            notify.publish(user.id, {"type": "unread_changed", "scope": "ai"})
        except Exception:
            pass
    return {"success": True}


@router.get("/stream/active")
async def stream_active(
    session_id: str = Query(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    s = db.get(ChatSession, session_id)
    if not s or s.dialogue.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")

    with _streams_lock:
        ids = list(_streams_by_session.get(session_id, set()))
    active = []
    for mid in ids:
        st = _get_stream(mid)
        if st and not st.finished:
            active.append(
                {
                    "message_id": st.message_id,
                    "content": st.content,
                    "last_seq": st.last_seq,
                    "started_at": st.started_at.isoformat(),
                }
            )
    return {"success": True, "active": active}


@router.post("/stream/abort")
async def stream_abort(
    body: AbortRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    s = db.get(ChatSession, body.session_id)
    if not s or s.dialogue.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")

    if body.assistant_message_id:
        st = _get_stream(body.assistant_message_id)
        if st:
            st.cancelled = True
            st.event.set()
    return {"success": True}


@router.post("/stream")
async def stream(
    body: ChatStreamRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    session = db.get(ChatSession, body.session_id)
    if not session or session.dialogue.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")

    loop = asyncio.get_running_loop()

    if body.assistant_message_id:
        # Подписка на уже идущий стрим
        state = _get_stream(body.assistant_message_id)
        if not state:
            # Стрим уже завершён и убран из реестра — отдаём сохранённый ответ из БД
            msg = db.get(ChatMessage, body.assistant_message_id)
            if not msg or msg.session_id != session.id:
                raise HTTPException(404, "Сообщение не найдено")

            attachment_info: dict | None = None
            if msg.attachment_document_id:
                from data.my_documents import MyDocuments
                doc = db.get(MyDocuments, msg.attachment_document_id)
                if doc:
                    attachment_info = {
                        "id": doc.id,
                        "title": doc.title,
                        "filename": Path(doc.file_path).name if doc.file_path else None,
                        "template_key": doc.template_key,
                    }

            async def _replay_done() -> AsyncIterator[bytes]:
                head = {
                    "initial": True,
                    "initial_chunk": msg.content or "",
                    "message_id": msg.id,
                    "last_seq": msg.last_seq or 0,
                }
                yield f"data: {json.dumps(head, ensure_ascii=False)}\n\n".encode("utf-8")
                done = {"done": True, "message_id": msg.id, "last_seq": msg.last_seq or 0}
                if attachment_info:
                    done["attachment"] = attachment_info
                yield f"data: {json.dumps(done, ensure_ascii=False)}\n\n".encode("utf-8")

            return StreamingResponse(
                _replay_done(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
    elif body.retry_of:
        # «Попробовать снова»: перегенерируем ответ на тот же вопрос как НОВЫЙ вариант.
        retried = db.get(ChatMessage, body.retry_of)
        if not retried or retried.session_id != session.id or retried.role != "assistant":
            raise HTTPException(404, "Ответ для повтора не найден")

        # Бэкфилл для старых сообщений без метаданных вариантов.
        if retried.variant_group is None:
            retried.variant_group = retried.id
        group = retried.variant_group

        # Пользовательский вопрос, на который отвечаем. reply_to может быть пуст у
        # старых сообщений — тогда берём ближайшее предыдущее сообщение пользователя.
        reply_to_id = retried.reply_to
        if not reply_to_id:
            prev_user = (
                db.query(ChatMessage)
                .filter(
                    ChatMessage.session_id == session.id,
                    ChatMessage.role == "user",
                    ChatMessage.id < retried.id,
                )
                .order_by(ChatMessage.id.desc())
                .first()
            )
            reply_to_id = prev_user.id if prev_user else None
            retried.reply_to = reply_to_id
        if not reply_to_id:
            raise HTTPException(400, "Не найден исходный вопрос для повтора")
        user_q = db.get(ChatMessage, reply_to_id)
        if not user_q:
            raise HTTPException(400, "Исходный вопрос недоступен")

        # Новый вариант становится активным, прежние — неактивны.
        db.query(ChatMessage).filter(
            ChatMessage.variant_group == group
        ).update({ChatMessage.variant_active: False}, synchronize_session=False)

        new_msg = ChatMessage(
            session_id=session.id,
            role="assistant",
            content="",
            is_read=False,
            is_finished=False,
            variant_group=group,
            variant_active=True,
            reply_to=reply_to_id,
        )
        db.add(new_msg)
        db.commit()
        db.refresh(new_msg)

        session.dialogue.last_activity = datetime.utcnow()
        db.commit()

        history = _collect_history_before(
            db, session.id, reply_to_id, limit=settings.rag_memory_recent_keep
        )
        # Вложения исходного вопроса (если были) — переиспользуем как контекст.
        att_docs = (
            db.query(SessionDocument)
            .filter(SessionDocument.message_id == reply_to_id)
            .order_by(SessionDocument.id.asc())
            .all()
        )
        attached_documents = [
            {"id": d.id, "filename": d.filename, "content": d.content, "stored_path": d.stored_path}
        for d in att_docs
        ]
        dialogue_summary = session.dialogue.memory_summary
        dialogue_id = session.dialogue.id
        owner_id = session.dialogue.user_id

        # Вопрос мог содержать пересланные из мессенджера сообщения — восстанавливаем
        # их в тексте запроса так же, как при первичной отправке.
        gen_text, use_rag_flag, forwarded = _gen_text_for_user_message(
            (user_q.content or "").strip(), user_q.forwarded_meta, body.use_rag
        )

        state = StreamState(
            session_id=session.id,
            message_id=new_msg.id,
            started_at=datetime.utcnow(),
        )
        _register_stream(state)

        threading.Thread(
            target=_run_generation,
            args=(
                session.id,
                gen_text,
                new_msg.id,
                dialogue_id,
                owner_id,
                use_rag_flag,
                history,
                attached_documents,
                dialogue_summary,
                state,
                loop,
                forwarded,
            ),
            daemon=True,
        ).start()
    else:
        # Пересланные из мессенджера сообщения (если есть) уходят с ПЕРВОЙ отправкой:
        # текст пользователя при этом может быть пустым.
        pending_fwd = session.dialogue.pending_forward
        msg_text = (body.message or "").strip()
        if not msg_text and not pending_fwd:
            raise HTTPException(400, "Не передано сообщение")

        # Якорь ветки: последний ВИДИМЫЙ ответ ассистента. Если пользователь
        # переключился на старую ветку и продолжил, вопрос прицепится к ней,
        # а не к скрытой новой (см. _hidden_message_ids).
        all_msgs = (
            db.query(ChatMessage)
            .filter(ChatMessage.session_id == session.id)
            .order_by(ChatMessage.id.asc())
            .all()
        )
        hidden_ids = _hidden_message_ids(all_msgs)
        branch_anchor = next(
            (m.id for m in reversed(all_msgs)
             if m.role == "assistant" and m.id not in hidden_ids),
            None,
        )

        # 1) Сохраняем сообщение пользователя
        user_msg = ChatMessage(
            session_id=session.id,
            role="user",
            content=msg_text,
            is_read=True,
            is_finished=True,
            forwarded_meta=pending_fwd,
            branch_of=branch_anchor,
        )
        db.add(user_msg)
        db.flush()
        if pending_fwd:
            session.dialogue.pending_forward = None

        # 2) Создаём заготовку ассистентского сообщения
        assistant_msg = ChatMessage(
            session_id=session.id,
            role="assistant",
            content="",
            is_read=False,
            is_finished=False,
        )
        db.add(assistant_msg)
        db.commit()
        db.refresh(assistant_msg)

        # Первый вариант ответа: группа = его собственный id, он активен, отвечает
        # на только что созданное сообщение пользователя (нужно для «попробовать снова»).
        assistant_msg.variant_group = assistant_msg.id
        assistant_msg.variant_active = True
        assistant_msg.reply_to = user_msg.id
        # Пользовательское сообщение — тоже первый вариант своей группы (для «изменить»).
        user_msg.variant_group = user_msg.id
        user_msg.variant_active = True
        db.commit()

        # 3) Обновляем активность диалога
        session.dialogue.last_activity = datetime.utcnow()
        db.commit()

        # История — ДО текущего вопроса: сам он уходит в промпт отдельно, и без
        # границы по id попадал бы в контекст дважды (с пересланным блоком — дорого).
        history = _collect_history_before(
            db, session.id, user_msg.id, limit=settings.rag_memory_recent_keep
        )

        # Вложения, ОЖИДАЮЩИЕ отправки (message_id IS NULL) — привязываем их к
        # текущему сообщению пользователя и кладём в контекст. К последующим
        # сообщениям они уже не подмешиваются (#8).
        pending_docs = (
            db.query(SessionDocument)
            .filter(
                SessionDocument.session_id == session.id,
                SessionDocument.message_id.is_(None),
            )
            .order_by(SessionDocument.id.asc())
            .all()
        )
        attached_documents = [
            {"id": d.id, "filename": d.filename, "content": d.content, "stored_path": d.stored_path}
            for d in pending_docs
        ]
        if pending_docs:
            for d in pending_docs:
                d.message_id = user_msg.id
            db.commit()

        dialogue_summary = session.dialogue.memory_summary
        dialogue_id = session.dialogue.id
        owner_id = session.dialogue.user_id

        gen_text, use_rag_flag, forwarded = _gen_text_for_user_message(
            msg_text, pending_fwd, body.use_rag
        )

        state = StreamState(
            session_id=session.id,
            message_id=assistant_msg.id,
            started_at=datetime.utcnow(),
            user_message_id=user_msg.id,
        )
        _register_stream(state)

        threading.Thread(
            target=_run_generation,
            args=(
                session.id,
                gen_text,
                assistant_msg.id,
                dialogue_id,
                owner_id,
                use_rag_flag,
                history,
                attached_documents,
                dialogue_summary,
                state,
                loop,
                forwarded,
            ),
            kwargs={"faq_id": body.faq_id},
            daemon=True,
        ).start()

    def _build_done_payload(message_id: int, last_seq: int) -> dict:
        payload: dict = {"done": True, "message_id": message_id, "last_seq": last_seq}
        d = create_session()
        try:
            msg = d.get(ChatMessage, message_id)
            # Финальный текст ПОСЛЕ пост-обработки (дедуп, восстановленные ссылки [k])
            # может отличаться от настримленного — клиент заменит содержимое пузыря.
            if msg and msg.content:
                payload["content"] = msg.content
            if msg and msg.sources:
                payload["sources"] = msg.sources
            if msg and msg.meta:
                payload["meta"] = msg.meta
            if msg and msg.attachment_document_id:
                from data.my_documents import MyDocuments
                doc = d.get(MyDocuments, msg.attachment_document_id)
                if doc:
                    payload["attachment"] = {
                        "id": doc.id,
                        "title": doc.title,
                        "filename": Path(doc.file_path).name if doc.file_path else None,
                        "template_key": doc.template_key,
                    }
            # Инфо о вариантах ответа (для навигации ‹ i/n ›) — актуально после ретрая.
            if msg and msg.role == "assistant":
                group = msg.variant_group or msg.id
                variants = _variant_list(d, msg.session_id, group, "assistant")
                if len(variants) > 1:
                    idx = next((i for i, v in enumerate(variants) if v.id == msg.id), len(variants) - 1)
                    payload["variant_group"] = group
                    payload["variant_index"] = idx + 1
                    payload["variant_count"] = len(variants)
        except Exception as e:
            logger.warning("done payload attachment lookup failed: {}", e)
        finally:
            d.close()
        return payload

    async def event_source() -> AsyncIterator[bytes]:
        # Сначала шлём initial snapshot для возобновлений / late subscribers
        initial_seq = body.last_seq or 0
        snapshot = state.buffer[initial_seq:]
        initial_text = "".join(snapshot)
        head = {
            "initial": True,
            "initial_chunk": initial_text,
            "message_id": state.message_id,
            "last_seq": state.last_seq,
            "status": state.status,
        }
        if state.user_message_id:
            head["user_message_id"] = state.user_message_id
        if state.sources:
            head["sources"] = state.sources
        yield f"data: {json.dumps(head, ensure_ascii=False)}\n\n".encode("utf-8")

        last_status = state.status
        last_yielded = state.last_seq
        sources_sent = bool(state.sources)
        try:
            while True:
                # Если уже всё выдали и стрим завершён — закрываем
                if state.finished and last_yielded >= state.last_seq:
                    yield (
                        f"data: {json.dumps(_build_done_payload(state.message_id, state.last_seq), ensure_ascii=False)}\n\n"
                    ).encode("utf-8")
                    if not body.assistant_message_id:
                        _unregister_stream(state)
                    break

                # Ждём новых событий (или таймаута для keepalive)
                try:
                    await asyncio.wait_for(state.event.wait(), timeout=10.0)
                except asyncio.TimeoutError:
                    # Heartbeat в виде data-события с маркером noop —
                    # клиент его явно отфильтровывает и не подмешивает в текст.
                    yield b'data: {"noop": true}\n\n'
                    continue
                state.event.clear()

                # Публикуем источники, как только они готовы (до текста)
                if not sources_sent and state.sources:
                    sources_sent = True
                    yield f"data: {json.dumps({'sources': state.sources, 'message_id': state.message_id}, ensure_ascii=False)}\n\n".encode("utf-8")

                # Обновление статуса (поиск / реранкинг / генерация)
                if state.status != last_status:
                    last_status = state.status
                    yield f"data: {json.dumps({'status': state.status, 'message_id': state.message_id})}\n\n".encode("utf-8")

                # Шлём накопившиеся чанки
                while last_yielded < state.last_seq:
                    chunk = state.buffer[last_yielded]
                    last_yielded += 1
                    payload = {
                        "seq": last_yielded,
                        "chunk": chunk,
                        "message_id": state.message_id,
                    }
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")

                if state.finished and last_yielded >= state.last_seq:
                    yield (
                        f"data: {json.dumps(_build_done_payload(state.message_id, state.last_seq), ensure_ascii=False)}\n\n"
                    ).encode("utf-8")
                    if not body.assistant_message_id:
                        _unregister_stream(state)
                    break
        except asyncio.CancelledError:
            # Клиент отключился — генерация продолжается в фоне
            logger.debug("SSE клиент отключился от сообщения {}", state.message_id)
            raise

    return StreamingResponse(event_source(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# Эфемерные вложения, прикреплённые к конкретной чат-сессии (не уходят в KB)
# ---------------------------------------------------------------------------


_ALLOWED_ATTACH_SUFFIXES = {".pdf", ".docx", ".doc", ".txt", ".md", ".csv", ".rtf", ".odt", ".xls", ".xlsx", ".xlsm", ".ods", ".pptx", ".ppt", ".odp", ".zip"}
_MAX_ATTACH_BYTES = 20 * 1024 * 1024  # 20 МБ
_MAX_ATTACH_PER_SESSION = 5


@router.post("/upload-document")
async def upload_session_document(
    session_id: str = Form(...),
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    session = db.get(ChatSession, session_id)
    if not session or session.dialogue.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _ALLOWED_ATTACH_SUFFIXES:
        raise HTTPException(400, f"Неподдерживаемый формат: {suffix}")

    existing = (
        db.query(SessionDocument).filter(SessionDocument.session_id == session_id).count()
    )
    if existing >= _MAX_ATTACH_PER_SESSION:
        raise HTTPException(400, f"Лимит вложений на сессию: {_MAX_ATTACH_PER_SESSION}")

    tmp_fd, tmp_name = tempfile.mkstemp(suffix=suffix)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(tmp_fd, "wb") as fp:
            shutil.copyfileobj(file.file, fp)
        size = tmp_path.stat().st_size
        if size > _MAX_ATTACH_BYTES:
            raise HTTPException(400, "Файл больше 20 МБ")

        # ZIP — контейнер для пакетных инструментов (дубликаты инструкций ОТ):
        # текст не извлекаем, храним только оригинал.
        if suffix == ".zip":
            text = f"[ZIP-архив: {file.filename or 'архив'}]"
            mime = "application/zip"
        else:
            try:
                parsed = parse_file(tmp_path)
            except Exception as e:
                raise HTTPException(400, f"Не удалось распарсить файл: {e}")
            text = (parsed.text or "").strip()
            mime = parsed.mime_type
            if not text:
                raise HTTPException(400, "Текст из файла извлечь не удалось (возможно, скан без OCR-распознавания)")

        # Сохраняем ОРИГИНАЛ каждого вложения: точные преобразования (отчёт по
        # ДПО, справка, опись, «Форма 2», схемы, ZIP) работают по исходному
        # файлу, а не по извлечённому тексту. Файл удаляется вместе с вложением.
        import uuid as _uuid

        keep_dir = settings.docs_dir / "session_files"
        keep_dir.mkdir(parents=True, exist_ok=True)
        keep = keep_dir / f"{_uuid.uuid4().hex}{suffix}"
        shutil.copyfile(tmp_path, keep)
        stored_path = str(keep)

        doc = SessionDocument(
            session_id=session_id,
            filename=file.filename or tmp_path.name,
            mime_type=mime,
            size_bytes=size,
            content=text,
            char_count=len(text),
            stored_path=stored_path,
        )
        db.add(doc)
        db.commit()
        db.refresh(doc)
    finally:
        tmp_path.unlink(missing_ok=True)

    return {
        "success": True,
        "file": {
            "id": doc.id,
            "name": doc.filename,
            "size": doc.size_bytes,
            "chars": doc.char_count,
        },
    }


@router.get("/session-files")
async def list_session_files(
    session_id: str = Query(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    session = db.get(ChatSession, session_id)
    if not session or session.dialogue.user_id != user.id:
        raise HTTPException(404, "Сессия не найдена")
    # Только «ожидающие» вложения (ещё не привязанные к сообщению) — это и есть
    # очередь на прикрепление к следующему сообщению (#8).
    items = (
        db.query(SessionDocument)
        .filter(
            SessionDocument.session_id == session_id,
            SessionDocument.message_id.is_(None),
        )
        .order_by(SessionDocument.id.asc())
        .all()
    )
    return {
        "success": True,
        "items": [
            {
                "id": d.id,
                "name": d.filename,
                "size": d.size_bytes,
                "chars": d.char_count,
                "created_at": d.created_at.isoformat(),
            }
            for d in items
        ],
    }


@router.delete("/session-files/{file_id}")
async def delete_session_file(
    file_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    doc = db.get(SessionDocument, file_id)
    if not doc:
        raise HTTPException(404, "Файл не найден")
    session = db.get(ChatSession, doc.session_id)
    if not session or session.dialogue.user_id != user.id:
        raise HTTPException(404, "Файл не найден")
    if doc.stored_path:
        try:
            p = Path(doc.stored_path).resolve()
            p.relative_to(settings.docs_dir.resolve())
            p.unlink(missing_ok=True)
        except (ValueError, OSError):
            pass
    db.delete(doc)
    db.commit()
    return {"success": True}


# ---------------------------------------------------------------------------
# Быстрый набор FAQ: меню кнопок для /chat (категория → вопрос → под-ветка)
# ---------------------------------------------------------------------------

# Человеческие названия категорий по файлам-источникам FAQ
_FAQ_CATEGORY_LABELS = [
    ("охрана труда", "Охрана труда"),
    ("аттестация ауп", "Аттестация АУП и УВП"),
    ("аттестация пр", "Аттестация ПР"),
    ("конкурс", "Конкурс, гранты, соцпрограмма"),
    ("обучение", "Обучение, вакансии, награды"),
]


def _faq_category(source_file: str | None) -> str:
    low = (source_file or "").lower()
    for key, label in _FAQ_CATEGORY_LABELS:
        if key in low:
            return label
    stem = Path(source_file or "FAQ").stem
    stem = stem.replace("чат-бот", "").strip(" -–_")
    return (stem[:1].upper() + stem[1:]) if stem else "Прочее"


@router.get("/faq-menu")
async def faq_menu(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Меню быстрого набора: категории → вопросы (блоки FAQ) → под-ветки.
    Финальная кнопка отправляет сообщение с faq_id → точный курируемый ответ."""
    from data.faq_entries import FAQEntry

    rows = (
        db.query(FAQEntry)
        .filter(FAQEntry.is_active.is_(True))
        .order_by(FAQEntry.source_file, FAQEntry.group_key, FAQEntry.position)
        .all()
    )
    groups: dict[str, dict] = {}
    for e in rows:
        g = groups.setdefault(e.group_key, {"head": None, "subs": []})
        if e.position == 0:
            g["head"] = e
        else:
            g["subs"].append(e)

    categories: dict[str, list[dict]] = {}
    for g in groups.values():
        head = g["head"] or (g["subs"][0] if g["subs"] else None)
        if head is None:
            continue
        variants = head.variants or []
        question = next((v for v in variants if len(v) > 3), None) or head.block or "Вопрос"
        item: dict = {"block": head.block or question, "question": question}
        if g["subs"]:
            item["options"] = [
                {
                    "id": s.id,
                    "label": (s.option_label or "").split(" / ")[0] or f"Вариант {i}",
                }
                for i, s in enumerate(g["subs"], 1)
            ]
        else:
            item["id"] = head.id
        categories.setdefault(_faq_category(head.source_file), []).append(item)

    for items in categories.values():
        items.sort(key=lambda x: x["block"].lower())
    return {
        "success": True,
        "categories": [
            {"label": label, "items": items}
            for label, items in sorted(categories.items())
        ],
    }
