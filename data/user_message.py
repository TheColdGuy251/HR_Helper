from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class UserMessage(SqlAlchemyBase):
    """Сообщение чата между пользователями (личный диалог или общий чат)."""

    __tablename__ = "user_messages"

    id: Mapped[int] = mapped_column(primary_key=True)

    sender_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # NULL + is_general=True → общий чат со всеми пользователями.
    recipient_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    is_general: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)

    content: Mapped[str] = mapped_column(Text, nullable=False, default="")

    # Пересланное сообщение ИИ-ассистента: снимок текста/вложения/источников,
    # чтобы отображалось даже если оригинал изменится/удалится.
    # {"content", "attachment": {"id","title","filename"}|null, "sources": [...]}
    forwarded_meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # Ответ на сообщение (id другого UserMessage) и закрепление.
    reply_to_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("user_messages.id", ondelete="SET NULL"), nullable=True
    )
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    is_edited: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Сообщение-вопрос, адресованный ИИ-ассистенту (режим «спросить бота» в чате).
    # По нему UI помечает сообщение плашкой «Вопрос ассистенту».
    is_ai_query: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Список user_id, у которых сообщение «удалено только у себя».
    hidden_for: Mapped[list | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )


class UserMessageReaction(SqlAlchemyBase):
    """Реакция-эмодзи на сообщение. Один пользователь — одна реакция на сообщение."""

    __tablename__ = "user_message_reactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("user_messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    emoji: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())


class Poll(SqlAlchemyBase):
    """Голосование, привязанное к сообщению мессенджера."""

    __tablename__ = "polls"

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("user_messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    allow_multiple: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    show_voters: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    allow_change: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Может ли ИИ-ассистент голосовать в этом опросе (по просьбе в чате).
    allow_bot: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())


class PollOption(SqlAlchemyBase):
    __tablename__ = "poll_options"

    id: Mapped[int] = mapped_column(primary_key=True)
    poll_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("polls.id", ondelete="CASCADE"), nullable=False, index=True
    )
    text: Mapped[str] = mapped_column(String(300), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class PollVote(SqlAlchemyBase):
    __tablename__ = "poll_votes"

    id: Mapped[int] = mapped_column(primary_key=True)
    poll_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("polls.id", ondelete="CASCADE"), nullable=False, index=True
    )
    option_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("poll_options.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())


class UserMessageFile(SqlAlchemyBase):
    """Файл, прикреплённый к сообщению мессенджера (хранится на диске)."""

    __tablename__ = "user_message_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    # NULL пока сообщение не отправлено (загружено, но не привязано).
    message_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("user_messages.id", ondelete="CASCADE"), nullable=True, index=True
    )
    owner_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    original_name: Mapped[str] = mapped_column(String(500), nullable=False)
    stored_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_image: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Размеры изображения (для резервирования места под серый плейсхолдер до загрузки).
    img_w: Mapped[int | None] = mapped_column(Integer, nullable=True)
    img_h: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )


class MessengerRead(SqlAlchemyBase):
    """Отметка прочтения диалога пользователем: до какого id сообщений прочитано.
    peer_key — id собеседника (личный диалог) или 'general' (общий чат)."""

    __tablename__ = "messenger_reads"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    peer_key: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    last_read_id: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Момент последнего прочтения — устойчив к переиспользованию rowid в SQLite.
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
