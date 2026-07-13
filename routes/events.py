"""SSE-канал уведомлений: один поток на пользователя. Заменяет частый поллинг
готовности генерации/названия диалога (#16)."""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from data.users import User
from services import notify
from utils.auth_deps import require_user

router = APIRouter(prefix="/api", tags=["events"])


@router.get("/events")
async def events(request: Request, user: User = Depends(require_user)):
    q = notify.subscribe(user.id)

    async def gen() -> AsyncIterator[bytes]:
        # Обрыв клиента и остановка сервера приходят как CancelledError (Starlette/
        # uvicorn отменяют генератор) — срабатывает finally и подписка снимается.
        # Чистый ASGI-middleware (без BaseHTTPMiddleware) + timeout_graceful_shutdown
        # обеспечивают корректное закрытие SSE при остановке.
        try:
            yield b'data: {"type":"hello"}\n\n'
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode("utf-8")
                except asyncio.TimeoutError:
                    yield b'data: {"type":"ping"}\n\n'  # keepalive — заодно ловит обрыв
        except asyncio.CancelledError:
            raise
        finally:
            notify.unsubscribe(user.id, q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
