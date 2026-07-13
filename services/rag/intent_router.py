"""Semantic-router: дешёвый эмбеддинговый pre-filter поверх существующего энкодера.

Регэксп `needs_planner` ловит структурные запросы по триггер-словам (цифры, «статья»,
«последний», «сравни»). Этот роутер добирает перефразировки БЕЗ таких слов — сравнивая
эмбеддинг запроса с примерами «структурных» и «семантических» намерений. Новая
зависимость не нужна — переиспользуем `services.embeddings.get_encoder`.

Используется как ИЛИ-сигнал к регэкспу (никогда не снижает полноту), включается флагом
settings.rag_use_semantic_router. Извлечение параметров (номера, N, кореференция) всё
равно остаётся за LLM-планировщиком — роутер только решает «звать планировщик или нет».
"""
from __future__ import annotations

from functools import lru_cache

from config import settings
from services.embeddings import get_encoder
from utils.logger import logger

# Примеры намерений. Можно расширять — это «обучение без кода»: добавил фразу-пример,
# и близкие к ней формулировки начинают роутиться так же.
_STRUCTURAL_EXAMPLES = [
    "статья 81",
    "процитируй статью 192",
    "что написано в статье 84.1",
    "последняя статья кодекса",
    "самая первая статья",
    "финальная норма документа",
    "первые три статьи",
    "последние пять статей",
    "покажи две начальные статьи",
    "сравни статью 80 и 81",
    "чем отличается перевод от перемещения",
    "процитируй её целиком",
    "покажи её полностью",
]
_SEMANTIC_EXAMPLES = [
    "как оформить отпуск работнику",
    "что делать при простое предприятия",
    "как оплачивается работа в выходной день",
    "порядок увольнения по собственному желанию",
    "какие гарантии у беременных сотрудниц",
    "что такое сверхурочная работа",
    "как рассчитать компенсацию за неиспользованный отпуск",
    "обязан ли работодатель индексировать зарплату",
]


def _cos(a: list[float], b: list[float]) -> float:
    s = na = nb = 0.0
    for x, y in zip(a, b):
        s += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return s / ((na ** 0.5) * (nb ** 0.5))


class _Router:
    def __init__(self) -> None:
        self._svecs: list[list[float]] | None = None
        self._qvecs: list[list[float]] | None = None

    def _ensure(self) -> None:
        if self._svecs is not None:
            return
        enc = get_encoder()
        self._svecs = enc.encode(_STRUCTURAL_EXAMPLES, is_query=True)
        self._qvecs = enc.encode(_SEMANTIC_EXAMPLES, is_query=True)
        logger.info(
            "[ROUTER] прогрет: {} структурных + {} семантических примеров",
            len(self._svecs), len(self._qvecs),
        )

    def scores(self, query: str) -> tuple[float, float]:
        """Возвращает (макс. близость к структурным, макс. близость к семантическим)."""
        self._ensure()
        qv = get_encoder().encode_one(query, is_query=True)
        s = max(_cos(qv, v) for v in self._svecs)
        m = max(_cos(qv, v) for v in self._qvecs)
        return s, m


@lru_cache(maxsize=1)
def get_router() -> _Router:
    return _Router()


def is_structural(query: str, threshold: float | None = None) -> bool:
    """True, если запрос ближе к структурным примерам, чем к семантическим, и
    превышает порог уверенности. На ошибке — False (откат к регэксп-гейту)."""
    q = (query or "").strip()
    if not q:
        return False
    threshold = threshold if threshold is not None else settings.rag_router_threshold
    try:
        s, m = get_router().scores(q)
    except Exception as e:
        logger.warning("[ROUTER] сбой, пропускаю: {}", e)
        return False
    decision = s >= threshold and s > m
    if decision:
        logger.info("[ROUTER] structural (s={:.3f} ≥ {:.2f}, semantic={:.3f})", s, threshold, m)
    return decision
