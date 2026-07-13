"""In-process hub уведомлений: сервер пушит события в открытые SSE-соединения
пользователя вместо поллинга каждые N секунд (#16).

Однопроцессная модель (uvicorn без --workers): фоновые потоки публикуют события
через сохранённый event loop (`call_soon_threadsafe`)."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timezone

from utils.logger import logger

_loop: asyncio.AbstractEventLoop | None = None
_subscribers: dict[int, set[asyncio.Queue]] = defaultdict(set)
# Присутствие: последний момент, когда у пользователя было активное соединение.
_last_seen: dict[int, datetime] = {}


def set_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def subscribe(user_id: int) -> asyncio.Queue:
    was_online = bool(_subscribers.get(user_id))
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers[user_id].add(q)
    _last_seen[user_id] = datetime.now(timezone.utc)
    # Пуш присутствия: собеседники обновляют «Онлайн» без поллинга /presence.
    if not was_online:
        publish_all({"type": "presence", "user_id": user_id, "online": True})
    return q


def unsubscribe(user_id: int, q: asyncio.Queue) -> None:
    subs = _subscribers.get(user_id)
    if subs:
        subs.discard(q)
        if not subs:
            _subscribers.pop(user_id, None)
    _last_seen[user_id] = datetime.now(timezone.utc)
    if not _subscribers.get(user_id):
        publish_all({
            "type": "presence", "user_id": user_id, "online": False,
            "last_seen": _last_seen[user_id].isoformat(),
        })


def is_online(user_id: int) -> bool:
    return bool(_subscribers.get(user_id))


def last_seen(user_id: int) -> datetime | None:
    return _last_seen.get(user_id)


def publish_all(event: dict) -> None:
    """Доставляет событие ВСЕМ подключённым пользователям (broadcast:
    системные уведомления, обновления базы знаний)."""
    for uid in list(_subscribers.keys()):
        publish(uid, event)


def publish(user_id: int | None, event: dict) -> None:
    """Потокобезопасно доставляет событие всем соединениям пользователя.
    Безопасно вызывать из фоновых потоков. No-op, если нет подписчиков/loop."""
    if not user_id or _loop is None:
        return
    subs = list(_subscribers.get(user_id, ()))
    if not subs:
        return

    def _put() -> None:
        for q in subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    try:
        _loop.call_soon_threadsafe(_put)
    except RuntimeError as e:
        logger.debug("notify.publish: loop недоступен: {}", e)
