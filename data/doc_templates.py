from __future__ import annotations

from datetime import datetime
from sqlalchemy import String, Text, DateTime, JSON, Boolean, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class DocTemplate(SqlAlchemyBase):
    """Шаблон HR-документа (приказ, заявление и т.п.)."""

    __tablename__ = "doc_templates"

    id: Mapped[int] = mapped_column(primary_key=True)

    key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    file_path: Mapped[str] = mapped_column(String(500), nullable=False)  # путь к .docx с {{поле}}

    # JSON-schema полей: {name, label, type, required, hint, options?}
    fields_schema: Mapped[list | None] = mapped_column(JSON, nullable=True)

    # Подсказки для LLM при автоизвлечении полей из текста запроса
    extraction_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)

    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Категория шаблона (приём/отпуск/увольнение/…). NULL => «Прочее» при отображении.
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("template_categories.id", ondelete="SET NULL"), nullable=True, index=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
