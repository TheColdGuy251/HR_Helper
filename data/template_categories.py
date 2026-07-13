from __future__ import annotations

from datetime import datetime
from sqlalchemy import String, DateTime, Integer, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class TemplateCategory(SqlAlchemyBase):
    """Категория HR-шаблонов: «Приём», «Отпуск», «Благодарность», «Увольнение», «Прочее» и т.п."""

    __tablename__ = "template_categories"

    id: Mapped[int] = mapped_column(primary_key=True)

    slug: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    icon: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=100)

    # Шаблон по умолчанию для этой категории
    default_template_id: Mapped[int | None] = mapped_column(
        ForeignKey("doc_templates.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )


# Слаг → (название, иконка fontawesome, порядок) для seed-данных.
DEFAULT_CATEGORIES: tuple[tuple[str, str, str, int], ...] = (
    ("hiring",    "Приём на работу",      "fa-user-plus",     10),
    ("vacation",  "Отпуск",                "fa-umbrella-beach", 20),
    ("gratitude", "Благодарность",         "fa-award",          30),
    ("dismissal", "Увольнение",            "fa-user-minus",     40),
    ("other",     "Прочее",                "fa-file-alt",       100),
)
