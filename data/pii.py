from __future__ import annotations

from datetime import date, datetime
from sqlalchemy import String, Date, DateTime, ForeignKey, Integer, Text, JSON, func, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from data.db_session import SqlAlchemyBase


class PIIPerson(SqlAlchemyBase):
    """Сотрудник, персональные данные которого хранятся в системе.
    Идентификатор — комбинация ФИО + (опционально) дата рождения при совпадении ФИО.
    """

    __tablename__ = "pii_persons"
    __table_args__ = (
        UniqueConstraint(
            "surname", "name", "patronymic", "birth_date",
            name="uq_pii_person_fio_dob",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    surname: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    patronymic: Mapped[str | None] = mapped_column(String(128), nullable=True)
    birth_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    # Опциональные метаданные (должность, отдел и т.д.) — НЕ шифруются,
    # т.к. сами по себе не считаются критичными PII (для поиска удобно).
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )

    documents = relationship(
        "PIIDocument", back_populates="person", cascade="all, delete-orphan"
    )

    @property
    def full_name(self) -> str:
        parts = [self.surname, self.name, self.patronymic or ""]
        return " ".join(p for p in parts if p).strip()


class PIIDocument(SqlAlchemyBase):
    """Зашифрованный файл, прикреплённый к PIIPerson.
    Сам файл хранится в settings.docs_dir/personal/<uuid>.enc.
    """

    __tablename__ = "pii_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("pii_persons.id", ondelete="CASCADE"), nullable=False, index=True
    )

    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    storage_filename: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Произвольный комментарий HR (тип документа, № договора и т.д.)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    uploaded_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )

    person = relationship("PIIPerson", back_populates="documents")


class PIIAuditLog(SqlAlchemyBase):
    """Аудит-журнал действий с PII: кто что когда смотрел/менял."""

    __tablename__ = "pii_audit"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    # view_person | upload | download | delete | reauth_ok | reauth_fail | timeout_save
    entity: Mapped[str | None] = mapped_column(String(64), nullable=True)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )
