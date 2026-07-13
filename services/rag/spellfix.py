"""Коррекция опечаток в запросе — для РОУТИНГА и ПОИСКА, не для показа.

Регэксп-гейты (smalltalk, doc-intent, планировщик) и BM25 не переживают опечаток:
«пиривет» не распознаётся как приветствие, «преказ» не триггерит генерацию
документа, «дкумент» не находится поиском. Здесь — дешёвый детерминированный
слой без внешних зависимостей:

1. слово, ИЗВЕСТНОЕ морфологии (pymorphy3), не трогаем — правим только опечатки;
2. неизвестное слово сравниваем со словарём триггеров/HR-терминов по расстоянию
   Дамерау-Левенштейна (≤1 для коротких слов, ≤2 для длинных);
3. при совпадении подставляем словарную основу — регэкспы и лемматизация BM25
   работают по основам, так что потеря окончания не мешает.

Исходный текст пользователя НЕ изменяется: правленная строка используется только
внутри пайплайна (гейты, retrieval); модель видит оригинал и сама устойчива к
опечаткам при генерации ответа.
"""
from __future__ import annotations

import re
from functools import lru_cache

from utils.logger import logger

# Словарь целей коррекции: триггеры роутинга + частотные HR-термины.
# Держим ОСНОВЫ/начальные формы: после подстановки сработают и регэкспы-стемы
# («приказ» в looks_like_doc_request), и лемматизация BM25.
_LEXICON: tuple[str, ...] = (
    # приветствия / вежливость (гейт smalltalk)
    "привет", "здравствуйте", "здравствуй", "спасибо", "благодарю", "пожалуйста",
    "пока", "свидания", "доброе", "добрый", "утро", "вечер",
    # команды генерации документов (looks_like_doc_request / detect_template)
    "приказ", "документ", "заявление", "справка", "шаблон", "бланк", "записка",
    "служебная", "оформи", "оформить", "сформируй", "сформировать", "создай",
    "создать", "сделай", "сделать", "подготовь", "подготовить", "сгенерируй",
    "нанять", "принять", "уволить",
    # частотные HR-термины (retrieval/BM25)
    "отпуск", "увольнение", "зарплата", "оклад", "премия", "аттестация",
    "командировка", "договор", "декрет", "больничный", "стажировка", "обучение",
    "награда", "характеристика", "вакансия", "статья", "кодекс", "трудовой",
    "сотрудник", "работник", "инструкция", "охрана", "труда", "выходной",
    "прогул", "испытательный", "совместительство", "переработка", "сокращение",
    "медосмотр", "выплата", "компенсация", "пособие", "беременность",
    # вопросительные слова (гейты информационного запроса)
    "сколько", "когда", "почему", "зачем", "какой", "какие", "расскажи",
    "объясни", "подскажи", "покажи",
)

_TOKEN_RE = re.compile(r"[а-яёА-ЯЁ]+")


@lru_cache(maxsize=1)
def _morph():
    """pymorphy3-анализатор (None, если пакет недоступен — тогда правим только
    точные несловарные совпадения по дистанции, без проверки «известности»)."""
    try:
        import pymorphy3

        return pymorphy3.MorphAnalyzer()
    except Exception as e:  # pragma: no cover
        logger.warning("[SPELLFIX] pymorphy3 недоступен ({}) — коррекция ограничена", e)
        return None


def _dl_distance(a: str, b: str, limit: int) -> int:
    """Расстояние Дамерау-Левенштейна (с транспозицией) с ранним выходом > limit."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2: list[int] | None = None
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        row_min = i
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            v = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if prev2 is not None and i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                v = min(v, prev2[j - 2] + 1)
            cur[j] = v
            row_min = min(row_min, v)
        if row_min > limit:
            return limit + 1
        prev2, prev = prev, cur
    return prev[len(b)]


def _limit_for(length: int) -> int:
    return 1 if length <= 5 else 2


@lru_cache(maxsize=50_000)
def _correct_word(word: str) -> str:
    """Возвращает исправленное слово или исходное. Кэш — слова повторяются."""
    if len(word) < 4 or word in _LEXICON:
        return word
    m = _morph()
    if m is not None and m.word_is_known(word):
        return word  # корректная словоформа — не трогаем (иначе испортим падежи)
    limit = _limit_for(len(word))
    best: str | None = None
    best_d = limit + 1
    for lex in _LEXICON:
        # Сравниваем и целиком, и по длине словарного слова (+1): опечатка часто
        # в основе, а хвост-окончание («преказом» → «приказ») дистанцию не раздувает.
        d = min(
            _dl_distance(word, lex, limit),
            _dl_distance(word[: len(lex) + 1], lex, limit),
        )
        if d < best_d:
            best, best_d = lex, d
            if d == 0:
                break
    return best if best is not None and best_d <= limit else word


def correct_typos(text: str) -> str:
    """Правит опечатки в неизвестных словах по словарю триггеров.
    «пиривет» → «привет», «преказ» → «приказ», «дкумент» → «документ».
    Корректные слова и незнакомые словарю (фамилии и т.п.) остаются как есть."""
    if not text:
        return text

    changed = False

    def _repl(m: re.Match) -> str:
        nonlocal changed
        w = m.group(0)
        fixed = _correct_word(w.lower())
        if fixed == w.lower():
            return w
        changed = True
        return fixed

    out = _TOKEN_RE.sub(_repl, text)
    if changed:
        logger.info("[SPELLFIX] '{}' → '{}'", text[:80], out[:80])
    return out
