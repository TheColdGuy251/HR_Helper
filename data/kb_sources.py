from __future__ import annotations

from datetime import datetime
from sqlalchemy import String, DateTime, Integer, Boolean, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class KBSource(SqlAlchemyBase):
    """Внешний веб-источник для регулярного парсинга."""

    __tablename__ = "kb_sources"

    id: Mapped[int] = mapped_column(primary_key=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    url: Mapped[str] = mapped_column(String(1000), nullable=False, unique=True)

    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    refresh_interval_hours: Mapped[int] = mapped_column(Integer, nullable=False, default=24)

    # Приоритет для RAG (см. KBDocument.priority). Применяется ко всем документам,
    # созданным из этого источника при следующей переиндексации.
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=2)

    last_crawled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(32), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
