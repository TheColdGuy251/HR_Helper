from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Request
from fastapi.templating import Jinja2Templates

from config import settings

TEMPLATES_DIR = Path(settings.base_dir) / "templates"


_STATIC_DIR = Path(settings.base_dir) / "static"
_static_mtime_cache: dict[str, str] = {}


def _static_version(filename: str) -> str:
    """Возвращает короткий хеш-идентификатор файла (используется как ?v=...).

    Кешируется в RAM, в debug-режиме обновляется при каждом обращении.
    """
    if not settings.debug and filename in _static_mtime_cache:
        return _static_mtime_cache[filename]
    full = _STATIC_DIR / filename
    try:
        v = str(int(full.stat().st_mtime))
    except OSError:
        v = "0"
    _static_mtime_cache[filename] = v
    return v


def _flask_url_for(request: Request) -> Any:
    """Эмулирует flask `url_for('static', filename=...)` для существующих шаблонов.
    К ссылкам на статику автоматически добавляется `?v=<mtime>` для cache-busting.
    """

    def url_for(endpoint: str, **values: Any) -> str:
        if endpoint == "static":
            filename = values.get("filename", "")
            base = str(request.url_for("static", path=filename))
            ver = _static_version(filename)
            sep = "&" if "?" in base else "?"
            return f"{base}{sep}v={ver}"
        try:
            url = request.url_for(endpoint, **values)
            return str(url)
        except Exception:
            return f"/{endpoint}"

    return url_for


def time_ago(value: datetime | str | None) -> str:
    if value is None:
        return "—"
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return value
    now = datetime.now(value.tzinfo) if value.tzinfo else datetime.now()
    delta = now - value
    seconds = int(delta.total_seconds())
    if seconds < 60:
        return "только что"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} мин назад"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} ч назад"
    days = hours // 24
    if days < 7:
        return f"{days} дн назад"
    return value.strftime("%d.%m.%Y")


templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
templates.env.filters["time_ago"] = time_ago


def render(request: Request, name: str, context: dict[str, Any] | None = None):
    """Рендер шаблона с инжектом текущего пользователя и url_for-аналога."""
    ctx: dict[str, Any] = {}
    if context:
        ctx.update(context)

    user = getattr(request.state, "user", None)
    ctx.setdefault("current_user", _CurrentUserProxy(user))
    ctx.setdefault("user_name", user.short_name if user else "Гость")
    ctx.setdefault("user_full_name", user.full_name if user else "")
    ctx.setdefault("user_initials", user.initials if user else "")
    ctx.setdefault("user_position", user.position if user else "")
    ctx.setdefault("user_sex", user.sex if user else "unknown")

    ctx.setdefault("url_for", _flask_url_for(request))

    return templates.TemplateResponse(request, name, ctx)


class _CurrentUserProxy:
    """Заглушка под flask-login current_user для совместимости с шаблонами."""

    def __init__(self, user):
        self._user = user

    @property
    def is_authenticated(self) -> bool:
        return self._user is not None

    def __getattr__(self, item):
        if self._user is None:
            return None
        return getattr(self._user, item, None)
