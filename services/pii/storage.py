"""Файловое хранилище зашифрованных PII-документов."""
from __future__ import annotations

import uuid
from pathlib import Path

from config import settings
from services.pii.crypto import encrypt_bytes, decrypt_bytes


def _personal_dir() -> Path:
    p = settings.docs_dir / "personal"
    p.mkdir(parents=True, exist_ok=True)
    return p


def store_encrypted(content: bytes) -> tuple[str, int]:
    """Сохраняет content зашифрованным, возвращает (storage_filename, original_size)."""
    storage_name = f"{uuid.uuid4().hex}.enc"
    out = _personal_dir() / storage_name
    out.write_bytes(encrypt_bytes(content))
    return storage_name, len(content)


def load_decrypted(storage_name: str) -> bytes:
    path = _personal_dir() / storage_name
    if not path.exists():
        raise FileNotFoundError(storage_name)
    return decrypt_bytes(path.read_bytes())


def delete_file(storage_name: str) -> None:
    path = _personal_dir() / storage_name
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
