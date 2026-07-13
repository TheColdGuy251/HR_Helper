from __future__ import annotations

from datetime import datetime
from sqlalchemy import String, Text, DateTime, Integer, Boolean, JSON, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class FAQEntry(SqlAlchemyBase):
    """Курируемая FAQ-запись из файлов «чат-бот …» (А2).

    Записи одного блока с общими вариантами запросов объединяются group_key:
    у группы из нескольких записей бот сначала задаёт уточняющий вопрос
    (clarify_question первой записи), а option_label различает под-ветки.
    """

    __tablename__ = "faq_entries"

    id: Mapped[int] = mapped_column(primary_key=True)

    group_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # Порядок внутри группы (0 — первая запись, носитель clarify_question)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    source_file: Mapped[str | None] = mapped_column(String(255), nullable=True)
    block: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    # Варианты формулировок пользователя (общие для группы): ["Заявление", ...]
    variants: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Текст уточняющего вопроса бота (есть только у групп с ≥2 записями)
    clarify_question: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Метка под-ветки — ответ пользователя на уточняющий вопрос
    option_label: Mapped[str | None] = mapped_column(String(500), nullable=True)

    answer: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Названия нормативных документов / файлов / URL из колонки «Ссылка на …»
    doc_refs: Mapped[list | None] = mapped_column(JSON, nullable=True)
    contact: Mapped[str | None] = mapped_column(Text, nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )
