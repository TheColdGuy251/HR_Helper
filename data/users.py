from __future__ import annotations

from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column

from data.db_session import SqlAlchemyBase


class User(SqlAlchemyBase):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)

    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    surname: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    patronymic: Mapped[str | None] = mapped_column(String(64), nullable=True)

    position: Mapped[str] = mapped_column(String(128), nullable=False, default="HR-специалист")
    sex: Mapped[str | None] = mapped_column(String(16), nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Роль «редактор БЗ» (А6): загрузка/правка документов базы знаний, FAQ,
    # шаблонов. Администратор — редактор автоматически (см. require_kb_editor).
    is_kb_editor: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Доступ к разделу «Персональные данные». Снимается администратором, чтобы
    # отключить отдельного пользователя без удаления учётной записи.
    can_access_pii: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())

    @property
    def full_name(self) -> str:
        parts = [self.surname, self.name, self.patronymic or ""]
        return " ".join(p for p in parts if p).strip()

    @property
    def initials(self) -> str:
        first = (self.name or "").strip()[:1]
        last = (self.surname or "").strip()[:1]
        return (last + first).upper()

    @property
    def short_name(self) -> str:
        name = (self.name or "").strip()
        return f"{self.surname} {name[:1] + '.' if name else ''}".strip()
