from __future__ import annotations

from pathlib import Path
from typing import Iterator

import sqlalchemy as sa
from sqlalchemy import event
from sqlalchemy.orm import Session, sessionmaker, DeclarativeBase


class SqlAlchemyBase(DeclarativeBase):
    pass


_engine: sa.Engine | None = None
_factory: sessionmaker[Session] | None = None


def _apply_sqlite_pragmas(dbapi_connection, _connection_record):
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA journal_mode=WAL;")
    cur.execute("PRAGMA synchronous=NORMAL;")
    cur.execute("PRAGMA foreign_keys=ON;")
    cur.execute("PRAGMA temp_store=MEMORY;")
    cur.execute("PRAGMA cache_size=-20000;")  # ~20MB
    cur.close()


def global_init(db_file: str | Path) -> sa.Engine:
    global _engine, _factory
    if _engine is not None:
        return _engine

    db_file = str(db_file).strip()
    if not db_file:
        raise ValueError("Необходимо указать файл базы данных.")

    conn_str = f"sqlite:///{db_file}?check_same_thread=False"
    _engine = sa.create_engine(
        conn_str,
        echo=False,
        future=True,
        pool_pre_ping=True,
    )

    event.listens_for(_engine, "connect")(_apply_sqlite_pragmas)

    # Импорт всех моделей для регистрации в metadata
    from data import __all_models  # noqa: F401

    SqlAlchemyBase.metadata.create_all(_engine)
    _factory = sessionmaker(bind=_engine, expire_on_commit=False, autoflush=False)

    _apply_light_migrations(_engine)
    _seed_template_categories()
    return _engine


def _seed_template_categories() -> None:
    from data.template_categories import TemplateCategory, DEFAULT_CATEGORIES

    s = create_session()
    try:
        existing = {c.slug for c in s.query(TemplateCategory).all()}
        added = False
        for slug, name, icon, order in DEFAULT_CATEGORIES:
            if slug not in existing:
                s.add(TemplateCategory(slug=slug, name=name, icon=icon, sort_order=order))
                added = True
        if added:
            s.commit()
    finally:
        s.close()


def _apply_light_migrations(engine: sa.Engine) -> None:
    """SQLite ALTER TABLE для полей, добавленных после первого запуска.
    Не заменяет Alembic, но позволяет работать на одной БД без ручных миграций."""
    # (table, column, ddl)
    columns = [
        ("dialogues", "memory_summary", "TEXT"),
        ("dialogues", "draft", "TEXT"),
        ("dialogues", "memory_covers_up_to", "INTEGER NOT NULL DEFAULT 0"),
        # Пересылка сообщений мессенджера в диалог с ассистентом
        ("dialogues", "pending_forward", "JSON"),
        ("chat_messages", "forwarded_meta", "JSON"),
        # Ветвление диалога: к какому ответу ассистента «прицеплен» вопрос
        ("chat_messages", "branch_of", "INTEGER"),
        # Оригиналы табличных вложений чата (для точных преобразований, Б2+)
        ("session_documents", "stored_path", "VARCHAR(1000)"),
        ("chat_messages", "subqueries", "JSON"),
        # Мета ответа: контакт подразделения, уточняющий вопрос FAQ (А2/А3)
        ("chat_messages", "meta", "JSON"),
        ("chat_messages", "fact_check", "JSON"),
        ("chat_messages", "attachment_document_id", "INTEGER"),
        ("chat_messages", "finished_at", "DATETIME"),
        ("chat_messages", "variant_group", "INTEGER"),
        ("chat_messages", "variant_active", "BOOLEAN NOT NULL DEFAULT 1"),
        ("chat_messages", "reply_to", "INTEGER"),
        ("session_documents", "message_id", "INTEGER"),
        ("doc_templates", "category_id", "INTEGER"),
        ("kb_documents", "priority", "INTEGER NOT NULL DEFAULT 2"),
        ("kb_sources", "priority", "INTEGER NOT NULL DEFAULT 2"),
        ("users", "can_access_pii", "BOOLEAN NOT NULL DEFAULT 1"),
        ("users", "is_kb_editor", "BOOLEAN NOT NULL DEFAULT 0"),
        # Metadata + versioning (roadmap 1-2)
        ("kb_documents", "document_kind", "VARCHAR(32)"),
        ("kb_documents", "issuer", "VARCHAR(255)"),
        ("kb_documents", "effective_from", "DATE"),
        ("kb_documents", "effective_to", "DATE"),
        ("kb_documents", "tags", "JSON"),
        ("kb_documents", "is_archived", "BOOLEAN NOT NULL DEFAULT 0"),
        ("kb_documents", "content", "TEXT"),
        # Мессенджер: ответы и закрепление сообщений
        ("user_messages", "reply_to_id", "INTEGER"),
        ("user_messages", "is_pinned", "BOOLEAN NOT NULL DEFAULT 0"),
        ("user_messages", "hidden_for", "JSON"),
        ("user_messages", "is_edited", "BOOLEAN NOT NULL DEFAULT 0"),
        ("user_messages", "is_ai_query", "BOOLEAN NOT NULL DEFAULT 0"),
        ("polls", "allow_bot", "BOOLEAN NOT NULL DEFAULT 1"),
        ("messenger_reads", "last_read_at", "DATETIME"),
        # Мессенджер: размеры изображений для плейсхолдера
        ("user_message_files", "img_w", "INTEGER"),
        ("user_message_files", "img_h", "INTEGER"),
    ]
    with engine.begin() as conn:
        for table, column, ddl in columns:
            try:
                row = conn.execute(
                    sa.text(f"SELECT name FROM pragma_table_info('{table}') WHERE name=:c"),
                    {"c": column},
                ).fetchone()
                if row is None:
                    conn.execute(sa.text(f'ALTER TABLE {table} ADD COLUMN {column} {ddl}'))
            except Exception:
                # Таблицы может ещё не быть на первом запуске — это нормально.
                pass


def create_session() -> Session:
    if _factory is None:
        raise RuntimeError("База данных не инициализирована. Вызовите global_init().")
    return _factory()


def get_db() -> Iterator[Session]:
    """FastAPI dependency."""
    session = create_session()
    try:
        yield session
    finally:
        session.close()
