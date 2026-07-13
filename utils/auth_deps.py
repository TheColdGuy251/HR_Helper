from __future__ import annotations

from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from data.db_session import get_db
from data.users import User


def current_user_optional(request: Request, db: Session = Depends(get_db)) -> Optional[User]:
    user_id = request.session.get("user_id") if hasattr(request, "session") else None
    if not user_id:
        request.state.user = None
        return None
    user = db.get(User, user_id)
    request.state.user = user
    return user


def require_user(user: User | None = Depends(current_user_optional)) -> User:
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Требуется авторизация")
    return user


def require_kb_editor(user: User = Depends(require_user)) -> User:
    """Мутации базы знаний и FAQ: роль «редактор БЗ» (А6) или администратор."""
    if not (user.is_admin or user.is_kb_editor):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Нужна роль «редактор базы знаний» — обратитесь к администратору",
        )
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    """Только для администраторов (управление пользователями, просмотр чужих
    переписок, журнал действий)."""
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Доступ только для администраторов",
        )
    return user


def require_admin_redirect(request: Request, user: User | None = Depends(current_user_optional)):
    """HTML-страница администратора: не авторизован → на логин; не админ → на главную."""
    if user is None:
        raise _RedirectException(str(request.url_for("auth_login_page")))
    if not user.is_admin:
        raise _RedirectException("/")
    return user


def require_user_redirect(request: Request, user: User | None = Depends(current_user_optional)):
    """Для HTML-страниц: если не авторизован — редирект на /auth/login."""
    if user is None:
        raise _RedirectException(str(request.url_for("auth_login_page")))
    return user


class _RedirectException(Exception):
    def __init__(self, location: str):
        self.location = location


def redirect_exception_handler(_request: Request, exc: _RedirectException):
    return RedirectResponse(url=exc.location, status_code=status.HTTP_303_SEE_OTHER)
