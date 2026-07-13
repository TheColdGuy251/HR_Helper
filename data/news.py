from __future__ import annotations

from datetime import datetime

from sqlalchemy import String, Text, DateTime, Integer, Boolean, JSON, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class NewsPost(SqlAlchemyBase):
    """Новость HR-отдела: заголовок + богатый HTML-текст (с встроенными картинками)
    + список прикреплённых документов. Публикуют редакторы БЗ, читают все сотрудники."""

    __tablename__ = "news_posts"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    # Санитизированный HTML из редактора (текст, форматирование, <img> с /api/news/media/…)
    body_html: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Прикреплённые документы: [{"media_id": int, "name": str, "size": int, "url": str}]
    attachments: Mapped[list | None] = mapped_column(JSON, nullable=True)

    author_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    is_published: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class NewsMedia(SqlAlchemyBase):
    """Загруженный в новость файл (картинка или документ). Хранится на диске в
    docs/news, отдаётся через /api/news/media/{id}. Может быть загружен до
    сохранения поста (post_id=NULL) — привязка проставляется при сохранении."""

    __tablename__ = "news_media"

    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int | None] = mapped_column(
        ForeignKey("news_posts.id", ondelete="CASCADE"), nullable=True, index=True
    )
    original_name: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    stored_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_image: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    uploaded_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )


class NewsPoll(SqlAlchemyBase):
    """Голосование, прикреплённое к новости (одно на пост)."""

    __tablename__ = "news_polls"

    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int] = mapped_column(
        ForeignKey("news_posts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    allow_multiple: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    show_voters: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )


class NewsPollOption(SqlAlchemyBase):
    __tablename__ = "news_poll_options"

    id: Mapped[int] = mapped_column(primary_key=True)
    poll_id: Mapped[int] = mapped_column(
        ForeignKey("news_polls.id", ondelete="CASCADE"), nullable=False, index=True
    )
    text: Mapped[str] = mapped_column(String(300), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class NewsPollVote(SqlAlchemyBase):
    __tablename__ = "news_poll_votes"

    id: Mapped[int] = mapped_column(primary_key=True)
    poll_id: Mapped[int] = mapped_column(
        ForeignKey("news_polls.id", ondelete="CASCADE"), nullable=False, index=True
    )
    option_id: Mapped[int] = mapped_column(
        ForeignKey("news_poll_options.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
