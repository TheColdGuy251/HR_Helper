from __future__ import annotations

from datetime import datetime

from sqlalchemy import String, Text, DateTime, Integer, JSON, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class Notification(SqlAlchemyBase):
    """Системное уведомление (broadcast — видно всем пользователям).

    kind:
      web_update — парсер обнаружил изменение веб-страницы в базе знаний;
                    extra = {"old_content": <прежний текст>} для diff-просмотра.
    Системные уведомления НЕ удаляются после прочтения — прочтение лишь гасит
    бейдж (см. NotificationRead)."""

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Связанный документ БЗ (для web_update — новая версия страницы)
    document_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )


class NotificationRead(SqlAlchemyBase):
    """Отметка «пользователь видел уведомление» (гасит бейдж, запись остаётся)."""

    __tablename__ = "notification_reads"
    __table_args__ = (
        UniqueConstraint("notification_id", "user_id", name="uq_notification_read"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    notification_id: Mapped[int] = mapped_column(
        ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    read_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
