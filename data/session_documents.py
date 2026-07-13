from __future__ import annotations

from datetime import datetime
from sqlalchemy import String, Text, DateTime, ForeignKey, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class SessionDocument(SqlAlchemyBase):
    """Файл, прикреплённый ТОЛЬКО к текущей чат-сессии.

    Контент не уходит в общую базу знаний (Qdrant), а используется
    как локальный контекст для подмешивания в промпт LLM.
    """

    __tablename__ = "session_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # К какому сообщению пользователя привязано вложение. NULL = ещё не отправлено
    # («ожидает» — уйдёт в контекст следующего сообщения). После отправки
    # проставляется id сообщения, и в контекст последующих оно уже НЕ подмешивается (#8).
    message_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=True, index=True
    )

    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Копия оригинального файла на диске — ТОЛЬКО для табличных форматов
    # (.xlsx/.xlsm): точные преобразования (отчёт по ДПО и т.п.) требуют сами
    # колонки, а не распарсенный текст. Для остальных форматов NULL.
    stored_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    char_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
