"""Перенос данных из SQLite в PostgreSQL.

Одноразовая утилита для перехода на PostgreSQL: читает старую базу
db/hr_helper.db и переливает все таблицы в БД, указанную в DATABASE_URL.
Схема в PostgreSQL создаётся из тех же SQLAlchemy-моделей, что использует
приложение, поэтому структура гарантированно совпадает.

Запуск (из каталога backend):
    python migrate_to_postgres.py

Переменные окружения:
    DATABASE_URL  — адрес PostgreSQL (можно задать в .env)
    SQLITE_FILE   — путь к исходной базе (по умолчанию db/hr_helper.db)

Скрипт идемпотентен в том смысле, что перед переливкой требует пустых таблиц:
если в целевой базе уже есть данные, он остановится (чтобы не задвоить).
Для принудительной перезаписи передайте --force: таблицы будут очищены.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import settings  # noqa: E402
from data.db_session import SqlAlchemyBase  # noqa: E402
from data import __all_models  # noqa: F401,E402  (регистрация моделей в metadata)


def human(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def main() -> int:
    force = "--force" in sys.argv

    sqlite_file = os.environ.get("SQLITE_FILE") or str(settings.db_file)
    target_url = os.environ.get("DATABASE_URL") or settings.database_url
    if not target_url:
        print("Не задан DATABASE_URL (адрес PostgreSQL). Укажите его в .env или в окружении.")
        return 1
    if not Path(sqlite_file).exists():
        print(f"Исходная база не найдена: {sqlite_file}")
        return 1

    print(f"Источник : {sqlite_file}")
    print(f"Приёмник : {target_url.split('@')[-1]}")  # без логина и пароля
    print()

    src = sa.create_engine(f"sqlite:///{sqlite_file}?check_same_thread=False", future=True)
    dst = sa.create_engine(target_url, future=True)

    # Схема в приёмнике — из моделей приложения.
    SqlAlchemyBase.metadata.create_all(dst)

    tables = SqlAlchemyBase.metadata.sorted_tables  # порядок с учётом внешних ключей

    # Проверка, что приёмник пуст.
    with dst.connect() as conn:
        non_empty = []
        for t in tables:
            cnt = conn.execute(sa.select(sa.func.count()).select_from(t)).scalar() or 0
            if cnt:
                non_empty.append((t.name, cnt))
    if non_empty and not force:
        print("В целевой базе уже есть данные:")
        for name, cnt in non_empty:
            print(f"  {name}: {human(cnt)} строк")
        print("\nПовторный запуск задвоил бы записи. Очистите базу или запустите с --force.")
        return 2

    if non_empty and force:
        print("Очистка целевых таблиц (--force)...")
        with dst.begin() as conn:
            for t in reversed(tables):
                conn.execute(t.delete())

    SrcSession = sessionmaker(bind=src, future=True)
    total_rows = 0

    with SrcSession() as s_src, dst.begin() as conn_dst:
        # doc_templates и template_categories ссылаются друг на друга, поэтому
        # порядка вставки, удовлетворяющего всем внешним ключам, не существует.
        # На время переливки отключаем их проверку (в конце транзакции режим
        # сбрасывается сам вместе с сессией).
        if dst.dialect.name == "postgresql":
            conn_dst.execute(sa.text("SET session_replication_role = replica"))

        for table in tables:
            rows = [dict(r._mapping) for r in s_src.execute(sa.select(table))]
            if not rows:
                print(f"  {table.name:<24} пусто")
                continue
            # Вставляем пачками — так заметно быстрее на больших таблицах.
            for i in range(0, len(rows), 500):
                conn_dst.execute(table.insert(), rows[i : i + 500])
            total_rows += len(rows)
            print(f"  {table.name:<24} {human(len(rows))} строк")

        if dst.dialect.name == "postgresql":
            conn_dst.execute(sa.text("SET session_replication_role = DEFAULT"))

    # После вставки строк с явными id счётчики последовательностей PostgreSQL
    # остаются на нуле — следующая вставка упала бы с конфликтом ключа.
    if dst.dialect.name == "postgresql":
        print("\nОбновление счётчиков последовательностей...")
        with dst.begin() as conn:
            for table in tables:
                pk = list(table.primary_key.columns)
                if len(pk) != 1:
                    continue
                col = pk[0]
                if not isinstance(col.type, sa.Integer):
                    continue
                seq = conn.execute(
                    sa.text("SELECT pg_get_serial_sequence(:t, :c)"),
                    {"t": table.name, "c": col.name},
                ).scalar()
                if not seq:
                    continue
                conn.execute(
                    sa.text(
                        f"SELECT setval(:seq, COALESCE((SELECT MAX({col.name}) FROM {table.name}), 0) + 1, false)"
                    ),
                    {"seq": seq},
                )

    print(f"\nГотово. Перенесено строк: {human(total_rows)}")
    print("Теперь укажите DATABASE_URL в backend/.env и frontend/.env — оба приложения")
    print("должны работать с одной базой.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
