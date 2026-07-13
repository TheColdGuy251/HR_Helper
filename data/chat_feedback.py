from __future__ import annotations

from datetime import datetime
from sqlalchemy import Text, DateTime, Integer, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class ChatFeedback(SqlAlchemyBase):
    """Реакция пользователя на ответ ассистента (✓/✗) + опциональный комментарий.

    Используется для (а) ручного анализа качества ответов, (б) future-обучения
    реранкера, (в) учёта boost/debuff для источников, помеченных как «полезные».
    """

    __tablename__ = "chat_feedback"
    __table_args__ = (
        UniqueConstraint("message_id", "user_id", name="uq_chat_feedback_per_user"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(
        ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # 1 = «полезно», -1 = «бесполезно/неверно»
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
