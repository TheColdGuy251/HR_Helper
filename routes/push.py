from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from data.db_session import get_db
from data.push_subscription import PushSubscription
from data.users import User
from services import push
from utils.auth_deps import require_user

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/vapid-public-key")
async def vapid_public_key(user: User = Depends(require_user)):
    """Публичный VAPID-ключ (applicationServerKey) для подписки на Web Push."""
    return {"key": push.public_key(), "available": push.is_available()}


@router.post("/subscribe")
async def subscribe(
    subscription: dict = Body(..., embed=True),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    endpoint = subscription.get("endpoint")
    keys = subscription.get("keys") or {}
    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    if not endpoint or not p256dh or not auth:
        raise HTTPException(400, "Некорректная подписка")
    existing = db.query(PushSubscription).filter(PushSubscription.endpoint == endpoint).first()
    if existing:
        existing.user_id = user.id
        existing.p256dh = p256dh
        existing.auth = auth
    else:
        db.add(PushSubscription(
            user_id=user.id, endpoint=endpoint, p256dh=p256dh, auth=auth,
            user_agent=(subscription.get("ua") or "")[:400] or None,
        ))
    db.commit()
    return {"ok": True}


@router.post("/unsubscribe")
async def unsubscribe(
    endpoint: str = Body(..., embed=True),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    if endpoint:
        db.query(PushSubscription).filter(
            PushSubscription.endpoint == endpoint, PushSubscription.user_id == user.id
        ).delete()
        db.commit()
    return {"ok": True}
