"""Контекстное определение намерения запроса (вместо ключевых слов).

Двухуровневая схема:

1. СЕМАНТИЧЕСКИЙ уровень (~10-30 мс, всегда): эмбеддинг запроса сравнивается с
   прототипами четырёх классов. Ловит перефразировки без единого триггер-слова
   («набросай мне приказ», «чё как дела то»)) — то, что регэкспы не видят.
2. LLM-уровень (только пограничные случаи, когда топ-2 класса близки): модель
   классифицирует запрос с учётом последних реплик диалога.

`resolve_intent()` возвращает класс или None («не уверен» / LLM недоступна) —
вызывающий код в этом случае откатывается к прежним регэксп-гейтам, поэтому
классификатор только РАСШИРЯЕТ распознавание, не сужая его.

Классы:
- smalltalk    — приветствия, благодарности, вопросы о самом ассистенте;
- doc_generate — команда создать/оформить документ по шаблону;
- kb_question  — содержательный кадровый вопрос (поиск по базе знаний);
- meta_chat    — вопрос о самой переписке («о чём мы говорили»).
"""
from __future__ import annotations

import re
from functools import lru_cache

from config import settings
from utils.logger import logger

INTENT_EXAMPLES: dict[str, list[str]] = {
    "smalltalk": [
        "привет", "привет!", "здравствуйте", "добрый день", "доброе утро",
        "спасибо большое", "спасибо, понял", "благодарю за помощь", "пока",
        "до свидания", "как дела?", "чё как?", "кто ты?", "ты кто такой?",
        "это кто?", "ты бот или человек?", "что ты умеешь?", "чем можешь помочь?",
        "как тебя зовут?", "ахаха, смешно", "ок, понятно", "круто!", "ну ты даёшь",
    ],
    "doc_generate": [
        "оформи приказ об отпуске на Иванову", "сделай заявление на отпуск",
        "подготовь приказ о приёме на работу", "сформируй справку на работника",
        "создай документ об увольнении Петрова", "нанять лаборанта Сидорову",
        "оформи отпуск по беременности и родам на Смирнову",
        "нужно заявление о переносе отпуска", "сделай служебную записку",
        "выдай бланк заявления на увольнение", "набросай приказ на отпуск",
        "заполни заявление на увольнение по собственному",
        "мне нужен документ о назначении материально ответственного лица",
        "напиши заявление о выходе из отпуска",
        "привет! оформи приказ об отпуске на Иванову",
    ],
    "kb_question": [
        "как оформить отпуск?", "что говорит статья 81 трудового кодекса?",
        "какие документы нужны при приёме на работу?",
        "сколько дней отпуска положено в год?", "как проходит аттестация?",
        "можно ли уволить сотрудника на больничном?",
        "что такое сверхурочная работа", "как оплачивается работа в выходной день",
        "какой порядок увольнения по собственному желанию",
        "где найти положение о наградах", "кто может получить грант",
        "какая периодичность медосмотра", "что положено молодым НПР",
        "хочу взять пару дней за свой счёт, что мне делать?",
        "какие гарантии у беременных сотрудниц",
        "работник опаздывает, какое взыскание можно применить?",
        "сотрудник не вышел на работу, что делать?",
        "что положено сотруднице, уходящей в декрет?",
        # Смешанные сообщения: приветствие + содержательный вопрос → это ВОПРОС.
        "привет! подскажи, что говорит статья 70 трудового кодекса",
        "здравствуйте, можно текст статьи 81?",
        "привет, перечисли основания для увольнения",
        "добрый день! как оформить отпуск за свой счёт?",
    ],
    "meta_chat": [
        "о чём мы говорили?", "что происходило в чате?",
        "перескажи нашу переписку", "подведи итог разговора",
        "что обсуждали выше?", "о чём этот диалог?", "напомни, о чём шла речь",
        "сделай краткое содержание беседы",
    ],
}

VALID_INTENTS = set(INTENT_EXAMPLES)

# Референсные слова («её», «это», «продолжи») — короткий запрос с ними понятен
# только из истории; семантике доверять нельзя, сразу пограничный случай.
_REFERENTIAL_SHORT_RE = re.compile(
    r"\b(её|ее|его|их|это|этой|этого|тот|ту|та|там|выше|дальше|продолж|ещё|еще)\b",
    re.IGNORECASE,
)


def _cos(a: list[float], b: list[float]) -> float:
    s = na = nb = 0.0
    for x, y in zip(a, b):
        s += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return s / ((na ** 0.5) * (nb ** 0.5))


class IntentClassifier:
    def __init__(self) -> None:
        self._vecs: dict[str, list[list[float]]] | None = None

    def _ensure(self) -> None:
        if self._vecs is not None:
            return
        from services.embeddings import get_encoder

        enc = get_encoder()
        # Приводим примеры к нижнему регистру перед эмбеддингом: энкодер регистро-
        # ЗАВИСИМ, и без нормализации «Как дела?» и «как дела?» дают разные векторы —
        # у порога/маржи это переворачивает вердикт. Запрос нормализуем так же.
        self._vecs = {
            intent: enc.encode([e.lower() for e in examples], is_query=True)
            for intent, examples in INTENT_EXAMPLES.items()
        }
        logger.info(
            "[INTENT] прототипы прогреты: {} классов, {} примеров",
            len(self._vecs), sum(len(v) for v in self._vecs.values()),
        )

    def semantic_scores(self, query: str) -> dict[str, float]:
        """Максимальная близость запроса к примерам каждого класса."""
        self._ensure()
        from services.embeddings import get_encoder

        qv = get_encoder().encode_one((query or "").lower(), is_query=True)
        return {
            intent: max(_cos(qv, v) for v in vecs)
            for intent, vecs in self._vecs.items()
        }

    def classify_fast(self, query: str) -> tuple[str | None, float, float]:
        """(intent | None, score, margin) — уверенный семантический вердикт или None."""
        scores = self.semantic_scores(query)
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        (top, top_s), (_, second_s) = ranked[0], ranked[1]
        margin = top_s - second_s
        if top_s >= settings.intent_semantic_threshold and margin >= settings.intent_semantic_margin:
            return top, top_s, margin
        return None, top_s, margin

    def classify_llm(self, query: str, history: list[dict] | None) -> str | None:
        """Пограничный случай → классификация моделью с учётом истории диалога."""
        from services.llm import get_llm
        from services.llm.prompts import SYSTEM_PROMPT_INTENT_ROUTER

        user_msg = query
        if history:
            recent = [
                f"{'Пользователь' if m.get('role') == 'user' else 'Ассистент'}: "
                f"{(m.get('content') or '')[:200]}"
                for m in history[-4:]
            ]
            user_msg = (
                "Последние реплики диалога:\n" + "\n".join(recent) +
                f"\n\nТекущий запрос: {query}"
            )
        try:
            data = get_llm().generate_json(
                SYSTEM_PROMPT_INTENT_ROUTER, user_msg,
                schema_hint='{"intent": "smalltalk|doc_generate|kb_question|meta_chat"}',
            )
        except Exception as e:
            logger.warning("[INTENT] LLM-классификация не удалась: {}", e)
            return None
        if not isinstance(data, dict) or data.get("_mock"):
            return None
        intent = str(data.get("intent") or "").strip().lower()
        return intent if intent in VALID_INTENTS else None


@lru_cache(maxsize=1)
def get_classifier() -> IntentClassifier:
    return IntentClassifier()


def resolve_intent(query: str, history: list[dict] | None = None) -> str | None:
    """Намерение запроса по КОНТЕКСТУ. None — не уверен (вызывающий код
    откатывается к регэксп-гейтам). Ошибки не роняют обработку сообщения."""
    q = (query or "").strip()
    if not q:
        return None
    try:
        clf = get_classifier()
        # Короткий референсный запрос («а её продолжи») без истории не понять —
        # семантике не доверяем, отдаём решение LLM (или фолбэку).
        referential = len(q) < 30 and bool(_REFERENTIAL_SHORT_RE.search(q))
        if not referential:
            intent, score, margin = clf.classify_fast(q)
            if intent is not None:
                logger.info(
                    "[INTENT] semantic: {} (score={:.3f}, margin={:.3f}) ← '{}'",
                    intent, score, margin, q[:60],
                )
                return intent
        if settings.intent_use_llm:
            intent = clf.classify_llm(q, history)
            if intent is not None:
                logger.info("[INTENT] llm: {} ← '{}'", intent, q[:60])
            return intent
    except Exception as e:
        logger.warning("[INTENT] сбой классификатора, фолбэк на регэкспы: {}", e)
    return None
