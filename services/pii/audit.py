from __future__ import annotations

from sqlalchemy.orm import Session

from data.pii import PIIAuditLog


def log(
    db: Session,
    user_id: int | None,
    action: str,
    entity: str | None = None,
    entity_id: int | None = None,
    extra: dict | None = None,
) -> None:
    db.add(
        PIIAuditLog(
            user_id=user_id,
            action=action,
            entity=entity,
            entity_id=entity_id,
            extra=extra,
        )
    )
    db.commit()
