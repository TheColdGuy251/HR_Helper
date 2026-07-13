from __future__ import annotations

from datetime import datetime
from sqlalchemy import String, DateTime, Integer, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class KBLink(SqlAlchemyBase):
    """Ссылка из одного фрагмента документа на статью/главу/пункт другого.

    Источник: distinct chunks_text, в которых встречается формулировка
    «согласно ст. 81», «см. главу 12», «в соответствии с п. 5».
    Цель: либо ссылка внутри того же документа (intradoc), либо
    нормативная ссылка типа «ст. 81 ТК», когда мы знаем кодекс.
    """

    __tablename__ = "kb_links"
    __table_args__ = (
        Index("ix_kb_link_target", "target_kind", "target_number"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    from_doc_id: Mapped[int] = mapped_column(
        ForeignKey("kb_documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    from_chunk_index: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Тип цели: article | chapter | clause | section
    target_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="article")
    # Номер цели (как строка, для поддержки «84.1»)
    target_number: Mapped[str] = mapped_column(String(16), nullable=False)
    # Опционально — код документа («ТК», «ГК», «ЛНА-12»). Пусто = внутри того же документа
    target_doc_hint: Mapped[str | None] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
