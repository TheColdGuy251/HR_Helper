from __future__ import annotations

from datetime import datetime
from sqlalchemy import String, Text, DateTime, ForeignKey, Boolean, Integer, JSON, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from data.db_session import SqlAlchemyBase


class ChatMessage(SqlAlchemyBase):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )

    role: Mapped[str] = mapped_column(String(16), nullable=False)  # user | assistant | system
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")

    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_finished: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_cancelled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Опционально: ссылки на источники RAG (список dict)
    sources: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Подвопросы (если включён decomposition)
    subqueries: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Результат self-check (см. RAGPipeline.self_check): {supported, total, issues}
    fact_check: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Если бот сгенерировал HR-документ — id записи в MyDocuments
    attachment_document_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Мета ответа ассистента (А2/А3): {"contact": str, "clarify": {"question", "options"},
    # "faq_id": int} — контакт подразделения и уточняющий вопрос FAQ для UI.
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Снимок сообщений, пересланных из мессенджера в этот диалог (список
    # {from_name, from_initials, chat, sent_at, text, ai, attachments}).
    # Есть только у сообщений пользователя; уходит в контекст модели.
    forwarded_meta: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Последний переданный seq (для возобновления стрима)
    last_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
    # Момент завершения генерации ответа ассистента (для показа времени сообщения).
    # У пользовательских сообщений остаётся NULL — для них берём created_at.
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Варианты ответа («попробовать снова» → новая ветка). Все альтернативные ответы
    # ассистента на один и тот же вопрос делят variant_group (= id первого варианта).
    # variant_active помечает вариант, который сейчас показывается. reply_to — id
    # пользовательского сообщения, на которое отвечает ассистент (нужно для ретрая).
    variant_group: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    variant_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    reply_to: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Ветка вопроса пользователя: id ответа ассистента, ПОСЛЕ которого (в видимой
    # на тот момент ветке) вопрос был задан. Вместе с reply_to образует дерево:
    # скрытие варианта каскадно скрывает всё его продолжение. NULL — первый вопрос
    # диалога или запись до внедрения ветвления (фолбэк — предыдущий ответ по id).
    branch_of: Mapped[int | None] = mapped_column(Integer, nullable=True)

    session = relationship("ChatSession", back_populates="messages")
