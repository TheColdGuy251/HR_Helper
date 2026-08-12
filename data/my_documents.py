from __future__ import annotations

from datetime import datetime
from sqlalchemy import Boolean, String, DateTime, ForeignKey, Integer, JSON, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class MyDocuments(SqlAlchemyBase):
    """Сгенерированные пользователем документы (приказы, заявления и пр.)."""

    __tablename__ = "my_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    title: Mapped[str] = mapped_column(String(255), nullable=False, default="Без названия")
    template_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    file_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # 0..100
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")  # draft|ready|exported

    # Заполненные поля шаблона
    fields: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # Документ содержит персональные данные (ТЗ: такие документы не храним) —
    # скрыт из «Моих документов» и автоматически удаляется по TTL вместе
    # с сообщениями чата (services/tasks/pii_cleanup.py).
    is_pii: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
    last_activity: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )
