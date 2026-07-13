from __future__ import annotations

from datetime import datetime
from sqlalchemy import String, Text, DateTime, ForeignKey, Boolean, Integer, JSON, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from data.db_session import SqlAlchemyBase


class Dialogue(SqlAlchemyBase):
    __tablename__ = "dialogues"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    title: Mapped[str] = mapped_column(String(255), nullable=False, default="Без названия")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    is_finished: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Сводка предыдущих сообщений диалога — для conversational memory.
    # Обновляется фоном после каждого N-го сообщения (см. settings.rag_memory_after_messages).
    memory_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    memory_covers_up_to: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Черновик (несохранённый текст поля ввода). Диалог без сообщений и без
    # черновика не показывается в списке («не сохраняется», #19).
    draft: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Пересланные из мессенджера сообщения, ожидающие ПЕРВОЙ отправки в этом
    # диалоге (снимок как в ChatMessage.forwarded_meta). Очищается при отправке.
    pending_forward: Mapped[list | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
    last_activity: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )

    sessions = relationship("ChatSession", back_populates="dialogue", cascade="all, delete-orphan")
