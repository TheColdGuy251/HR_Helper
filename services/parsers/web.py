from __future__ import annotations

import re

import httpx
import trafilatura

from config import settings
from services.parsers.base import ParsedDocument
from utils.logger import logger


# Описательный бот-UA — запасной для сайтов, которые ТРЕБУЮТ идентификации робота
# и блокируют браузерные UA (Wikimedia и др., «robot policy»). Основной UA —
# браузерный (settings.web_user_agent), т.к. большинство сайтов, наоборот, блокируют ботов.
_BOT_USER_AGENT = "HRHelperBot/1.0 (+https://www.tyuiu.ru; contact: hr-helper@tyuiu.ru)"
_BLOCK_CODES = {401, 403, 406, 429}


def fetch_url(url: str, timeout: int | None = None) -> str:
    """Скачивает страницу и возвращает декодированный HTML. Пробует браузерный UA;
    при блокировке (403/406/429/…) повторяет с описательным бот-UA."""
    agents = [settings.web_user_agent, _BOT_USER_AGENT]
    last_exc: Exception | None = None
    for i, ua in enumerate(agents):
        headers = {
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru,en;q=0.9",
        }
        try:
            with httpx.Client(
                headers=headers,
                timeout=timeout or settings.web_request_timeout,
                follow_redirects=True,
            ) as client:
                resp = client.get(url)
                resp.raise_for_status()
                # httpx берёт кодировку из Content-Type, иначе — charset_normalizer.
                return resp.text
        except httpx.HTTPStatusError as e:
            last_exc = e
            code = e.response.status_code if e.response is not None else None
            if code in _BLOCK_CODES and i + 1 < len(agents):
                logger.info("[WEB] {} вернул {} — повтор с альтернативным User-Agent", url, code)
                continue
            raise
    if last_exc:
        raise last_exc
    raise RuntimeError("fetch_url: недостижимо")


# Навигация «предыдущая/следующая статья», хлебные крошки в виде таблицы —
# типичный шум правовых/справочных баз. Убираем строки, где ОДНОВРЕМЕННО есть
# разделитель таблицы «|» и стрелки перехода «<<»/«>>» — обычная проза так не выглядит.
_NAV_ROW_RE = re.compile(r"\|.*(?:<<|>>)|(?:<<|>>).*\|")
_PIPE_ONLY_RE = re.compile(r"^[\s|]+$")
_MULTI_BLANK_RE = re.compile(r"\n{3,}")


def _clean_text(text: str) -> str:
    """Убирает навигационные артефакты и лишние пустые строки, не трогая содержимое."""
    if not text:
        return ""
    out: list[str] = []
    for ln in text.splitlines():
        s = ln.strip()
        if not s:
            out.append("")
            continue
        if _PIPE_ONLY_RE.match(s):
            continue
        if _NAV_ROW_RE.search(s):
            continue
        out.append(ln.rstrip())
    return _MULTI_BLANK_RE.sub("\n\n", "\n".join(out)).strip()


def _trafilatura_extract(html: str) -> str:
    """Основной путь: сбалансированное извлечение (чистый текст без сайдбаров/лент).
    Если контента почти нет — повторяем в режиме favor_recall (агрессивнее, ловит
    статьи на «бедных» разметкой страницах ценой части шума)."""
    common = dict(include_tables=True, include_links=False, include_comments=False, deduplicate=True)
    try:
        text = trafilatura.extract(html, **common) or ""
    except Exception as e:  # pragma: no cover
        logger.warning("trafilatura balanced failed: {}", e)
        text = ""
    if len(text.strip()) < 200:
        try:
            recall = trafilatura.extract(html, favor_recall=True, **common) or ""
        except Exception as e:  # pragma: no cover
            logger.warning("trafilatura recall failed: {}", e)
            recall = ""
        if len(recall.strip()) > len(text.strip()):
            text = recall
    return text


def _bs4_extract(html: str) -> str:
    """Запасной экстрактор: когда trafilatura ничего не дала. Берём <article>/<main>
    (иначе <body>), выкидываем скрипты/меню/подвалы и собираем видимый текст."""
    try:
        from bs4 import BeautifulSoup
    except Exception:
        return ""
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg"]):
        tag.decompose()
    main = soup.find("article") or soup.find("main") or soup.body or soup
    lines = [ln.strip() for ln in main.get_text("\n").splitlines() if ln.strip()]
    return "\n".join(lines)


def _extract_title(html: str, fallback: str) -> str:
    """Заголовок: метаданные trafilatura → <title>/<h1> → fallback (url)."""
    try:
        meta = trafilatura.extract_metadata(html)
        if meta and meta.title:
            return meta.title.strip()
    except Exception:
        meta = None
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "lxml")
        if soup.title and soup.title.string and soup.title.string.strip():
            return soup.title.string.strip()
        h1 = soup.find("h1")
        if h1 and h1.get_text(strip=True):
            return h1.get_text(strip=True)
    except Exception:
        pass
    return fallback


def parse_url(url: str) -> ParsedDocument:
    html = fetch_url(url)

    text = _clean_text(_trafilatura_extract(html))
    if len(text) < 40:
        # trafilatura не справилась (SPA/нетипичная разметка) — грубый запасной разбор.
        fallback = _clean_text(_bs4_extract(html))
        if len(fallback) > len(text):
            logger.info("[WEB] trafilatura дала {} симв., bs4-фолбэк — {}", len(text), len(fallback))
            text = fallback

    title = _extract_title(html, url)

    author = None
    try:
        meta = trafilatura.extract_metadata(html)
        author = getattr(meta, "author", None) if meta else None
    except Exception:
        pass

    logger.info("[WEB] {} → {} симв., заголовок: {}", url, len(text), (title or "")[:80])
    return ParsedDocument(
        text=text.strip(),
        title=title or url,
        source_uri=url,
        source_type="web",
        mime_type="text/html",
        extra={"author": author},
    )
