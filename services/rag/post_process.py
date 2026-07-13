"""Пост-обработка готового ответа LLM: удаление служебных <think>-блоков,
случайных CJK-иероглифов и повторяющихся подряд абзацев (LLM иногда
зацикливается на CPU)."""
from __future__ import annotations

import re

from utils.logger import logger

# Служебные «думающие» теги Qwen3-семейства (T-lite/T-pro могут их выдавать
# несмотря на non-thinking режим).
_THINK_RE = re.compile(r"<think>.*?</think>\s*", re.IGNORECASE | re.DOTALL)
# Отдельный незакрытый префикс <think>... в начале — тоже отсекаем.
_THINK_OPEN_RE = re.compile(r"^\s*<think>.*?(?=\n|$)", re.IGNORECASE | re.DOTALL)

# Иероглифы CJK (китайский / японский / корейский) — артефакт мультиязычной токенизации
# Qwen3. У нас всё на русском, такие символы — почти всегда ошибка модели.
_CJK_RE = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯]+")


def dedupe_paragraphs(answer: str, max_repeats: int = 1) -> str:
    """Удаляет подряд повторяющиеся абзацы (типичный артефакт CPU-генерации)."""
    if not answer:
        return answer
    paragraphs = re.split(r"\n\s*\n+", answer)
    out: list[str] = []
    last = None
    count = 0
    for p in paragraphs:
        key = re.sub(r"\s+", " ", p.strip()).lower()
        if key and key == last:
            count += 1
            if count > max_repeats:
                continue
        else:
            last = key
            count = 0
        out.append(p)
    return "\n\n".join(out)


def strip_think_blocks(answer: str) -> str:
    """Удаляет служебные `<think>…</think>` блоки (включая пустые `<think></think>`).
    Эти теги — артефакт reasoning-режима Qwen3, в готовом ответе они мусор."""
    if not answer:
        return answer
    out = _THINK_RE.sub("", answer)
    out = _THINK_OPEN_RE.sub("", out, count=1)
    return out.lstrip()


def strip_cjk(answer: str) -> str:
    """Удаляет китайские/японские/корейские иероглифы, если они случайно попали в ответ.
    Заменяем на маркер «[?]» — пользователь сразу увидит, что модель здесь сломалась,
    и сможет переспросить."""
    if not answer or not _CJK_RE.search(answer):
        return answer
    return _CJK_RE.sub("[?]", answer)


def post_process_answer(answer: str) -> str:
    """Финальная обработка: убрать <think>-блоки, иероглифы, дедуп повторов."""
    return dedupe_paragraphs(strip_cjk(strip_think_blocks(answer)))


# ---------------------------------------------------------------------------
# Гарантия инлайн-ссылок [k] в теле ответа
# ---------------------------------------------------------------------------

_REF_RE = re.compile(r"\[(\d{1,3})\]")
_SOURCES_HDR_RE = re.compile(r"(?m)^#{0,6}\s*источник[а-яё]*\s*[:：]?\s*$|\n##\s*Источники", re.IGNORECASE)
_HEADING_RE = re.compile(r"^#{1,6}\s")

# Минимальная косинусная близость абзаца к чанку-источнику для атрибуции.
_CITE_SIM_THRESHOLD = 0.40


def _cos(a: list[float], b: list[float]) -> float:
    s = na = nb = 0.0
    for x, y in zip(a, b):
        s += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return s / ((na ** 0.5) * (nb ** 0.5))


def ensure_inline_citations(answer: str, source_texts: list[str] | None) -> str:
    """Модель (особенно на низкой температуре) часто пишет блок «Источники», но
    забывает инлайн-ссылки [k] в тексте. Если в ТЕЛЕ ответа нет ни одной ссылки —
    расставляем их детерминированно: каждый содержательный абзац привязывается к
    ближайшему по эмбеддингу чанку-источнику ([k] ↔ source_texts[k-1], та же
    нумерация, что в промпте). Абзацы без уверенного соответствия не трогаем —
    ложная атрибуция хуже отсутствующей."""
    if not answer or not source_texts:
        return answer

    # Тело — до блока «Источники» (свой список модель пишет сама, там [k] не в счёт).
    m = _SOURCES_HDR_RE.search(answer)
    body, tail = (answer[: m.start()], answer[m.start():]) if m else (answer, "")
    if _REF_RE.search(body):
        return answer  # инлайн-ссылки уже есть

    paragraphs = re.split(r"(\n\s*\n+)", body)  # с сохранением разделителей
    try:
        from services.embeddings import get_encoder

        enc = get_encoder()
        src_vecs = enc.encode([t[:1500] for t in source_texts], is_query=False)

        changed = False
        for i in range(0, len(paragraphs), 2):
            p = paragraphs[i]
            stripped = p.strip()
            if len(stripped) < 60 or _HEADING_RE.match(stripped):
                continue
            pv = enc.encode_one(stripped[:1500], is_query=False)
            sims = [_cos(pv, sv) for sv in src_vecs]
            best = max(range(len(sims)), key=lambda j: sims[j])
            if sims[best] < _CITE_SIM_THRESHOLD:
                continue
            paragraphs[i] = p.rstrip() + f" [{best + 1}]"
            changed = True
        if changed:
            logger.info("[POST] инлайн-ссылки восстановлены по близости к источникам")
            return "".join(paragraphs) + tail
    except Exception as e:
        logger.warning("[POST] авторасстановка ссылок не удалась: {}", e)
    return answer
