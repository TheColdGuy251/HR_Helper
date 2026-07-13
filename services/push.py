"""Web Push — системные уведомления браузера/ОС, когда вкладка или приложение
закрыты (в отличие от SSE, который работает только при открытом соединении).

VAPID-ключи берём из настроек (.env) или генерируем один раз в db/vapid.json.
Отправка — через pywebpush (опциональная зависимость): если пакет не установлен,
всё тихо деградирует до in-page toast + Notification API открытой вкладки."""
from __future__ import annotations

import base64
import json
import threading
from pathlib import Path

from config import settings
from utils.logger import logger

_VAPID_FILE = Path(settings.db_dir) / "vapid.json"
_vapid: dict | None = None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _generate_keys() -> dict:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    priv = ec.generate_private_key(ec.SECP256R1())
    private_pem = priv.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")
    pub = priv.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )  # 65 байт uncompressed point → applicationServerKey для клиента
    return {"private_pem": private_pem, "public_b64": _b64url(pub)}


def _load() -> dict:
    global _vapid
    if _vapid is not None:
        return _vapid
    subject = settings.vapid_subject or "mailto:admin@localhost"
    if settings.vapid_private_key and settings.vapid_public_key:
        _vapid = {"private_pem": settings.vapid_private_key,
                  "public_b64": settings.vapid_public_key, "subject": subject}
        return _vapid
    try:
        if _VAPID_FILE.exists():
            data = json.loads(_VAPID_FILE.read_text("utf-8"))
        else:
            data = _generate_keys()
            _VAPID_FILE.parent.mkdir(parents=True, exist_ok=True)
            _VAPID_FILE.write_text(json.dumps(data), "utf-8")
            logger.info("VAPID-ключи сгенерированы: {}", _VAPID_FILE)
        data["subject"] = subject
        _vapid = data
    except Exception as e:  # noqa: BLE001
        logger.warning("VAPID init не удался: {}", e)
        _vapid = {}
    return _vapid


def public_key() -> str | None:
    return _load().get("public_b64") or None


def _webpush_available() -> bool:
    try:
        import pywebpush  # noqa: F401
        return True
    except Exception:
        return False


def is_available() -> bool:
    return bool(public_key()) and _webpush_available()


def _send(user_id: int, payload: dict) -> None:
    v = _load()
    if not v.get("private_pem"):
        return
    try:
        from pywebpush import WebPushException, webpush
    except Exception:
        return
    from data.db_session import create_session
    from data.push_subscription import PushSubscription

    s = create_session()
    try:
        subs = s.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
        if not subs:
            return
        body = json.dumps(payload)
        removed = False
        for sub in subs:
            try:
                webpush(
                    subscription_info={"endpoint": sub.endpoint,
                                       "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
                    data=body,
                    vapid_private_key=v["private_pem"],
                    vapid_claims={"sub": v["subject"]},
                    timeout=10,
                )
            except WebPushException as e:  # noqa: PERF203
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status in (404, 410):        # подписка мертва — удаляем
                    s.delete(sub)
                    removed = True
                else:
                    logger.debug("web push {}: {}", status, e)
            except Exception as e:  # noqa: BLE001
                logger.debug("web push send failed: {}", e)
        if removed:
            s.commit()
    finally:
        s.close()


def notify_user(user_id: int, payload: dict) -> None:
    """Асинхронно (в отдельном потоке) шлёт push всем подпискам пользователя.
    payload: {title, body, url, tag}. No-op, если push недоступен."""
    if not user_id:
        return
    threading.Thread(target=_send, args=(user_id, payload), daemon=True).start()
