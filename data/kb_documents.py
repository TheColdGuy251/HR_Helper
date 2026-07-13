from __future__ import annotations

from datetime import date, datetime
from sqlalchemy import String, Text, DateTime, Date, Integer, Boolean, JSON, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class KBDocument(SqlAlchemyBase):
    """Документ базы знаний (нормативный акт, инструкция, парсенная веб-страница и т.п.)."""

    __tablename__ = "kb_documents"

    id: Mapped[int] = mapped_column(primary_key=True)

    title: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)  # local|web|upload
    source_uri: Mapped[str] = mapped_column(String(1000), nullable=False)  # путь к файлу или URL
    file_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)  # sha256
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)

    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    # pending | parsing | indexed | failed

    # Приоритет для RAG: 1=низкий, 2=средний (по умолчанию), 3=высокий.
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=2)

    # Метаданные документа
    document_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # code | law | regulation | order | manual | other
    issuer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # «Минтруд», «Госдума», «Учёный совет ТИУ» и т.п.
    effective_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    tags: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Список свободных тегов: ["увольнение", "отпуска", "дисциплина"]

    # Архивная редакция — по умолчанию вне retrieval
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    chunks_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Полный извлечённый текст (для предпросмотра, особенно веб-страниц, у которых нет
    # файла на диске). Локальные файлы можно перечитать, но храним единообразно.
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
