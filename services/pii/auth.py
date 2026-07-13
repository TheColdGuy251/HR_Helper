"""Кратко-живущий токен доступа к разделу PII.
Используем itsdangerous Signer (стек у нас уже есть)."""
from __future__ import annotations

from datetime import datetime, timezone

from itsdangerous import BadSignature, SignatureExpired, TimestampSigner

from config import settings

PII_TOKEN_TTL_SEC = 60 * 15  # 15 минут
_SALT = "pii-reauth-v1"


def _signer() -> TimestampSigner:
    return TimestampSigner(secret_key=settings.secret_key, salt=_SALT)


def issue_token(user_id: int) -> str:
    return _signer().sign(str(user_id)).decode("utf-8")


def _unsign(token: str, *, return_timestamp: bool = False):
    return _signer().unsign(
        token, max_age=PII_TOKEN_TTL_SEC, return_timestamp=return_timestamp
    )


def verify_token(token: str | None, user_id: int) -> bool:
    if not token:
        return False
    try:
        payload = _unsign(token)
    except (SignatureExpired, BadSignature):
        return False
    try:
        return int(payload.decode("utf-8")) == int(user_id)
    except (ValueError, AttributeError):
        return False


def token_remaining_seconds(token: str | None, user_id: int) -> int:
    """Сколько секунд осталось у токена. 0 — токен невалидный/просроченный."""
    if not token:
        return 0
    try:
        payload, issued_at = _unsign(token, return_timestamp=True)
    except (SignatureExpired, BadSignature):
        return 0
    try:
        if int(payload.decode("utf-8")) != int(user_id):
            return 0
    except (ValueError, AttributeError):
        return 0

    now = datetime.now(timezone.utc)
    # itsdangerous возвращает datetime в UTC (naive в старых версиях — приведём)
    if issued_at.tzinfo is None:
        issued_at = issued_at.replace(tzinfo=timezone.utc)
    elapsed = (now - issued_at).total_seconds()
    return max(0, int(PII_TOKEN_TTL_SEC - elapsed))
