from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from config import ensure_dirs, settings
from data.db_session import global_init
from routes import auth as auth_router
from routes import chat as chat_router
from routes import dialogues as dialogues_router
from routes import documents as docs_router
from routes import events as events_router
from routes import kb as kb_router
from routes import messenger as messenger_router
from routes import pages as pages_router
from routes import pii as pii_router
from routes import admin as admin_router
from routes import audit as audit_router
from routes import notifications as notifications_router
from routes import news as news_router
from routes import push as push_router
from services.tasks import start_scheduler, stop_scheduler
from utils.auth_deps import _RedirectException, redirect_exception_handler
from utils.logger import logger, setup_logger


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logger()
    ensure_dirs()
    global_init(settings.db_file)
    logger.info("Приложение {} запускается", settings.app_name)

    # Сохраняем event loop для пуша SSE-уведомлений из фоновых потоков (#16).
    import asyncio as _asyncio

    from services import notify

    notify.set_loop(_asyncio.get_running_loop())

    # Фоновый прогрев тяжёлых компонентов: эмбеддер, реранкер, LLM.
    # Сервер стартует моментально, а к моменту первого запроса пользователя
    # модели уже загружены — нет «холодного старта» в чате.
    import threading

    def _warmup() -> None:
        try:
            from services.embeddings import get_encoder
            from services.rag.reranker import get_reranker
            from services.vectorstore import get_store

            logger.info("Прогрев: эмбеддер")
            encoder = get_encoder()
            _ = encoder.encode_one("прогрев", is_query=True)

            logger.info("Прогрев: Qdrant коллекция")
            try:
                get_store().ensure_collection(dim=encoder.dim)
                # Строим BM25-индекс из Qdrant СРАЗУ при старте — иначе гибридный
                # поиск до первой переиндексации работает только на dense (BM25 пуст),
                # и теряются точные совпадения терминов («прогул», номера статей).
                logger.info("Прогрев: BM25 индекс")
                from services.rag.indexer import get_indexer
                get_indexer()._refresh_bm25(None)
            except Exception as e:
                logger.warning("Qdrant недоступен (dense+BM25 ограничены): {}", e)

            logger.info("Прогрев: реранкер")
            get_reranker()._load()

            logger.info("Прогрев: intent-классификатор")
            from services.rag.intent_classifier import get_classifier
            get_classifier()._ensure()

            # Возобновление индексаций, прерванных перезапуском сервера: иначе
            # документы навсегда зависают в статусе pending/parsing.
            try:
                from data.db_session import create_session
                from data.kb_documents import KBDocument
                from routes.kb import _submit_index

                _s = create_session()
                try:
                    stuck = (
                        _s.query(KBDocument)
                        .filter(KBDocument.status.in_(("pending", "parsing")))
                        .all()
                    )
                    for d in stuck:
                        p = Path(d.source_uri) if d.source_uri else None
                        if d.source_type == "local" and p and p.exists():
                            logger.info("Возобновляю индексацию документа {} ({})", d.id, d.title)
                            _submit_index(d.id, str(p))
                        else:
                            d.status = "failed"
                            d.error = "Индексация прервана перезапуском сервера"
                    _s.commit()
                finally:
                    _s.close()
            except Exception as e:
                logger.warning("Возобновление индексаций не удалось: {}", e)

            if settings.llm_enabled:
                from services.llm import get_llm
                logger.info("Прогрев: LLM")
                get_llm()._ensure_loaded()

            logger.info("Прогрев завершён")
        except Exception as e:
            logger.warning("Прогрев упал: {}", e)

    threading.Thread(target=_warmup, daemon=True).start()

    start_scheduler()
    try:
        yield
    finally:
        stop_scheduler()
        logger.info("Приложение остановлено")


app = FastAPI(title=settings.app_name, lifespan=lifespan, docs_url="/api/docs", redoc_url=None)


class CurrentUserMiddleware:
    """Кладёт текущего пользователя в request.state.user. Реализован как ЧИСТЫЙ
    ASGI-middleware (не BaseHTTPMiddleware): тот оборачивает ответ в task group и
    ломает стриминг SSE (`/api/events`, чат-стрим) — мешает завершению соединений
    и засоряет логи CancelledError при остановке."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        user = None
        session = scope.get("session") or {}
        user_id = session.get("user_id")
        if user_id:
            from data.db_session import create_session
            from data.users import User

            s = create_session()
            try:
                user = s.get(User, user_id)
            finally:
                s.close()
        scope.setdefault("state", {})["user"] = user
        await self.app(scope, receive, send)


# Content-Security-Policy: скрипты только свои (внешних <script> нет), inline-обработчики
# и <style> разрешены (их в шаблонах много); шрифты/иконки — с известных CDN; кадрирование
# сайта чужими доменами запрещено (анти-clickjacking). Строгие директивы можно отключить
# security_csp=false в .env, если что-то в предпросмотре документов заблокируется.
_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; "
    "img-src 'self' data: blob: https://storage.tyuiu.ru; "
    "connect-src 'self'; "
    "worker-src 'self' blob:; "
    "frame-src 'self' blob:; "
    "media-src 'self' blob:; "
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
)


class SecurityHeadersMiddleware:
    """Заголовки безопасности для КАЖДОГО ответа. Чистый ASGI (как CurrentUser) —
    правит только заголовки http.response.start, поэтому не ломает стриминг (SSE/чат)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not settings.security_headers:
            await self.app(scope, receive, send)
            return
        is_https = scope.get("scheme") == "https"
        for k, v in scope.get("headers", []):
            if k == b"x-forwarded-proto" and v.split(b",")[0].strip() == b"https":
                is_https = True  # за TLS-прокси

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])

                def seth(name, value):
                    headers.append((name.encode("latin-1"), value.encode("latin-1")))

                seth("X-Content-Type-Options", "nosniff")
                seth("X-Frame-Options", "SAMEORIGIN")
                seth("Referrer-Policy", "strict-origin-when-cross-origin")
                seth("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
                if is_https:
                    seth("Strict-Transport-Security", f"max-age={settings.hsts_max_age}; includeSubDomains")
                if settings.security_csp:
                    seth("Content-Security-Policy", _CSP)
            await send(message)

        await self.app(scope, receive, send_wrapper)


# Порядок: SessionMiddleware должен быть СНАРУЖИ (выполняться раньше), чтобы
# scope["session"] был доступен в CurrentUserMiddleware. add_middleware кладёт
# последний добавленный во внешний слой → добавляем CurrentUser ПЕРВЫМ.
app.add_middleware(CurrentUserMiddleware)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    session_cookie="hr_session",
    max_age=settings.session_max_age_sec,
    same_site=settings.session_same_site,
    https_only=settings.session_https_only,
)

# Внешний слой — заголовки безопасности на все ответы (включая статику и стримы).
app.add_middleware(SecurityHeadersMiddleware)


app.add_exception_handler(_RedirectException, redirect_exception_handler)

STATIC_DIR = Path(settings.base_dir) / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

app.include_router(pages_router.router)
app.include_router(auth_router.router)
app.include_router(dialogues_router.router)
app.include_router(chat_router.router)
app.include_router(events_router.router)
app.include_router(docs_router.router)
app.include_router(kb_router.router)
app.include_router(messenger_router.router)
app.include_router(pii_router.router)
app.include_router(audit_router.router)
app.include_router(admin_router.router)
app.include_router(notifications_router.router)
app.include_router(news_router.router)
app.include_router(push_router.router)


@app.exception_handler(404)
async def not_found(request: Request, exc):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"success": False, "error": "Not found"}, status_code=404)
    return RedirectResponse(url="/")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        # SSE-соединения (/api/events) не завершаются сами — закрываем их быстро при
        # остановке, чтобы сервер не висел на «Waiting for connections to close».
        timeout_graceful_shutdown=2,
    )
