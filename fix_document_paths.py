"""Починка абсолютных путей к файлам в базе данных.

Зачем нужен: в БД хранятся абсолютные пути к документам. Если каталог проекта
переименовали или перенесли (например, `HR Helper` → `backend`), пути остаются
старыми — приложение отвечает «Доступ к файлу запрещён» (путь вне `docs_dir`)
или «Файл не найден», хотя сами файлы на месте.

Скрипт переписывает пути так, чтобы они указывали внутрь текущего
`settings.docs_dir`, сохраняя часть пути после каталога `docs`.

Запуск (из каталога backend):
    python fix_document_paths.py            # показать, что будет сделано
    python fix_document_paths.py --apply    # записать изменения
"""
from __future__ import annotations

import sys
from pathlib import Path, PureWindowsPath

import sqlalchemy as sa

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import settings  # noqa: E402

# (таблица, колонка с путём) — все места, где хранится ПОЛНЫЙ путь к файлу.
# Здесь нет pii_documents: там лежит только имя файла в зашифрованном
# хранилище (storage_filename), каталог берётся из настроек при чтении.
TARGETS = [
    ("kb_documents", "source_uri"),
    ("doc_templates", "file_path"),
    ("my_documents", "file_path"),
    ("news_media", "stored_path"),
    ("user_message_files", "stored_path"),
    ("session_documents", "stored_path"),
]


def remap(old: str, docs_dir: Path) -> str | None:
    """Переносит путь внутрь актуального docs_dir.

    Ищем в исходном пути сегмент «docs» и берём всё, что после него, —
    структура внутри docs при переезде не меняется. Пути, не ведущие в docs
    (например, http-ссылки веб-источников), не трогаем.
    """
    if not old:
        return None
    # Пути в БД записаны в Windows-стиле; PureWindowsPath разберёт их и на Linux.
    parts = PureWindowsPath(old.replace("/", "\\")).parts
    lowered = [p.lower() for p in parts]
    if "docs" not in lowered:
        return None
    tail = parts[lowered.index("docs") + 1 :]
    if not tail:
        return None
    new = docs_dir.joinpath(*tail)
    return str(new) if str(new) != old else None


def main() -> int:
    apply = "--apply" in sys.argv
    docs_dir = Path(settings.docs_dir).resolve()
    url = settings.database_url or f"sqlite:///{settings.db_file}"
    engine = sa.create_engine(url, future=True)

    print(f"Актуальный каталог документов: {docs_dir}")
    print(f"База: {url.split('@')[-1]}")
    print("Режим:", "ЗАПИСЬ" if apply else "просмотр (--apply для записи)")
    print()

    total_changed = total_missing = 0

    # Каждая таблица — в своей транзакции. Иначе неудачный запрос (нет таблицы
    # или колонки) переводит транзакцию PostgreSQL в сбойное состояние, и уже
    # выполненные UPDATE откатываются вместе с ней.
    for table, column in TARGETS:
        try:
            with engine.begin() as conn:
                rows = conn.execute(
                    sa.text(f"SELECT id, {column} FROM {table} WHERE {column} IS NOT NULL")
                ).fetchall()

                changed = missing = 0
                for row_id, old in rows:
                    new = remap(str(old), docs_dir)
                    if not new:
                        continue
                    if not Path(new).exists():
                        missing += 1
                        if missing <= 3:
                            print(f"  [{table}#{row_id}] файла нет: {Path(new).name}")
                        continue
                    if apply:
                        conn.execute(
                            sa.text(f"UPDATE {table} SET {column} = :new WHERE id = :id"),
                            {"new": new, "id": row_id},
                        )
                    changed += 1
        except Exception as e:
            print(f"{table}.{column}: пропущено ({type(e).__name__})")
            continue

        if changed or missing:
            print(f"{table}.{column}: к обновлению {changed}, файл отсутствует у {missing}")
        total_changed += changed
        total_missing += missing

    print()
    if apply:
        print(f"Обновлено записей: {total_changed}")
    else:
        print(f"Будет обновлено: {total_changed}. Запустите с --apply.")
    if total_missing:
        print(f"Пропущено (файл не найден на диске): {total_missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
