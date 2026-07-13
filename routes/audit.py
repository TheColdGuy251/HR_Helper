from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from data.db_session import get_db
from data.pii import PIIAuditLog
from data.users import User
from utils.auth_deps import require_user, require_user_redirect
from utils.templating import render

router = APIRouter()


@router.get("/audit", name="page_audit")
async def audit_page(request: Request, user: User = Depends(require_user_redirect)):
    # Журнал действий с ПДн — только для администраторов.
    if not user.is_admin:
        return RedirectResponse(url="/", status_code=303)
    return render(request, "audit.html", {})


@router.get("/api/audit/pii")
async def list_pii_audit(
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    action: str | None = Query(default=None),
    user_id: int | None = Query(default=None),
):
    if not user.is_admin:
        raise HTTPException(403, "Доступ только для администраторов")
    q = db.query(PIIAuditLog)
    if action:
        q = q.filter(PIIAuditLog.action == action)
    if user_id is not None:
        q = q.filter(PIIAuditLog.user_id == user_id)
    total = q.count()
    rows = q.order_by(PIIAuditLog.id.desc()).offset(offset).limit(limit).all()

    # Подтянем имена пользователей одним запросом
    user_ids = {r.user_id for r in rows if r.user_id is not None}
    users_map: dict[int, User] = {}
    if user_ids:
        for u in db.query(User).filter(User.id.in_(user_ids)).all():
            users_map[u.id] = u

    items = []
    for r in rows:
        u = users_map.get(r.user_id) if r.user_id else None
        items.append({
            "id": r.id,
            "at": r.at.isoformat(),
            "user_id": r.user_id,
            "user_name": u.short_name if u else None,
            "user_email": u.email if u else None,
            "action": r.action,
            "entity": r.entity,
            "entity_id": r.entity_id,
            "extra": r.extra,
        })
    return JSONResponse({"success": True, "items": items, "total": total, "limit": limit, "offset": offset})
