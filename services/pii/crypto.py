"""Шифрование персональных файлов: AES-256-GCM, ключ — HKDF из SECRET_KEY.

Каждый файл получает свой случайный nonce; зашифрованный поток =
[12 байт nonce][ciphertext + 16 байт tag].
"""
from __future__ import annotations

import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from config import settings


_KEY_CACHE: bytes | None = None


def _derive_key() -> bytes:
    """Производит AES-256 ключ из SECRET_KEY через HKDF (с константной солью).
    Один и тот же ключ для всех файлов PII — это нормально для AES-GCM,
    т.к. уникальность обеспечивает случайный nonce на каждый файл.
    """
    global _KEY_CACHE
    if _KEY_CACHE is not None:
        return _KEY_CACHE
    secret = (settings.secret_key or "").encode("utf-8")
    if not secret or len(secret) < 16:
        raise RuntimeError(
            "SECRET_KEY должен содержать минимум 16 байт для шифрования PII"
        )
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,  # AES-256
        salt=b"hr-helper-pii-salt-v1",
        info=b"pii-file-encryption",
    )
    _KEY_CACHE = hkdf.derive(secret)
    return _KEY_CACHE


def encrypt_bytes(data: bytes) -> bytes:
    nonce = os.urandom(12)
    aes = AESGCM(_derive_key())
    return nonce + aes.encrypt(nonce, data, associated_data=None)


def decrypt_bytes(blob: bytes) -> bytes:
    if len(blob) < 28:
        raise ValueError("Зашифрованный блок слишком короткий")
    nonce, ct = blob[:12], blob[12:]
    aes = AESGCM(_derive_key())
    return aes.decrypt(nonce, ct, associated_data=None)
