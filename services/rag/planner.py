"""Планировщик запросов: естественный язык → структурный план поиска.

Заменяет «зоопарк регэкспов» в pipeline.py. Вместо описания каждого частного случая
формулировки мы один раз спрашиваем LLM о НАМЕРЕНИИ запроса и получаем структуру,
по которой диспетчер выбирает стратегию retrieval. Падежи, синонимы, словесные
числительные («сорок седьмая статья») обобщает модель, а не наши паттерны.

Дёшево по латентности: для явно семантических запросов (нет цифр и структурных
триггеров) LLM вообще не вызывается — сразу mode="semantic".
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

from config import settings
from services.llm import get_llm
from services.llm.prompts import SYSTEM_PROMPT_PLANNER
from utils.logger import logger

VALID_MODES = {"semantic", "exact_article", "extreme", "range", "compare", "count"}
VALID_UNITS = {"article", "clause", "section", "chapter", "paragraph"}


# GBNF-грамматика: жёстко фиксирует структуру плана и enum значения mode/extreme/order.
# Модель физически не может вернуть невалидную схему — _normalize становится подстраховкой.
# ВАЖНО: каждое правило — на ОДНОЙ строке. Нативный парсер GBNF в llama.cpp
# отвергает многострочные правила («expecting name») и затем падает с native
# access-violation. Однострочная форма — канонична и парсится надёжно.
_PLAN_GRAMMAR = r'''root ::= "{" ws "\"mode\":" ws mode ws "," ws "\"unit\":" ws unit ws "," ws "\"article_nos\":" ws numarray ws "," ws "\"extreme\":" ws extreme ws "," ws "\"range_n\":" ws (integer | "null") ws "," ws "\"range_order\":" ws order ws "," ws "\"doc_hint\":" ws (string | "null") ws "," ws "\"search_text\":" ws string ws "}"
mode ::= "\"semantic\"" | "\"exact_article\"" | "\"extreme\"" | "\"range\"" | "\"compare\"" | "\"count\""
unit ::= "\"article\"" | "\"clause\"" | "\"section\"" | "\"chapter\"" | "\"paragraph\""
extreme ::= "\"first\"" | "\"last\"" | "null"
order ::= "\"asc\"" | "\"desc\""
numarray ::= "[" ws (number (ws "," ws number)*)? ws "]"
number ::= "-"? [0-9]+ ("." [0-9]+)?
integer ::= "-"? [0-9]+
string ::= "\"" char* "\""
char ::= [^"\\] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
ws ::= [ \t\n]*'''


@lru_cache(maxsize=1)
def _get_grammar():
    """Скомпилированный LlamaGrammar или None (если llama_cpp/грамматика недоступны —
    планировщик откатится на response_format=json_object)."""
    try:
        from llama_cpp import LlamaGrammar

        return LlamaGrammar.from_string(_PLAN_GRAMMAR)
    except Exception as e:
        logger.warning("[PLANNER] GBNF-грамматика недоступна, fallback на json_object: {}", e)
        return None


@dataclass
class QueryPlan:
    mode: str = "semantic"
    unit: str = "article"  # article | clause(пункт) | section(раздел) | chapter(глава) | paragraph(§)
    article_nos: list[float] = field(default_factory=list)
    extreme: str | None = None  # "first" | "last"
    range_n: int | None = None
    range_order: str = "asc"  # "asc" | "desc"
    doc_hint: str | None = None
    search_text: str = ""


# Быстрый pre-filter: стоит ли вообще звать планировщик. Если в запросе нет ни цифр,
# ни структурных слов — это почти наверняка обычный смысловой вопрос, экономим вызов LLM.
_STRUCTURAL_HINT_RE = re.compile(
    r"\d"
    r"|стат|глав|пункт|раздел|част"
    r"|перв|втор|трет|последн|финальн|заключительн|начальн|конечн|крайн"
    r"|сравн|разниц|различ|отлич|против",
    re.IGNORECASE,
)


def needs_planner(query: str) -> bool:
    return bool(_STRUCTURAL_HINT_RE.search(query or ""))


# Референсные продолжения: «процитируй её», «а что в ней», «покажи целиком», «подробнее».
# Их нельзя понять без истории — но если история есть, планировщик разрешит ссылку.
_REFERENTIAL_RE = re.compile(
    r"\b(её|ее|неё|нее|его|него|их|них|это|этой|этого|эту|этом|"
    r"ней|нём|нем|та|ту|той|том|там|выше|оно)\b"
    r"|процитир|процити|подробн|раскрой|целиком|полност|дальше|продолж",
    re.IGNORECASE,
)


def _looks_referential(query: str) -> bool:
    q = (query or "").strip()
    return len(q) < 30 or bool(_REFERENTIAL_RE.search(q))


def _coerce_float_list(value) -> list[float]:
    out: list[float] = []
    if not isinstance(value, list):
        value = [value]
    for v in value:
        if v is None:
            continue
        try:
            out.append(float(str(v).replace(",", ".").strip()))
        except (TypeError, ValueError):
            continue
    # дедуп, сохраняя порядок
    seen: set[float] = set()
    uniq: list[float] = []
    for n in out:
        if n not in seen:
            seen.add(n)
            uniq.append(n)
    return uniq


def _normalize(data: dict, query: str) -> QueryPlan:
    """Валидирует и приводит сырой JSON-ответ LLM к QueryPlan. Любое отклонение от
    схемы безопасно деградирует в semantic — пайплайн всегда останется рабочим."""
    if not isinstance(data, dict) or data.get("_mock"):
        return QueryPlan(mode="semantic", search_text=query)

    mode = str(data.get("mode") or "semantic").strip().lower()
    if mode not in VALID_MODES:
        mode = "semantic"

    unit = str(data.get("unit") or "article").strip().lower()
    if unit not in VALID_UNITS:
        unit = "article"

    article_nos = _coerce_float_list(data.get("article_nos"))

    extreme = data.get("extreme")
    extreme = extreme.strip().lower() if isinstance(extreme, str) else None
    if extreme not in ("first", "last"):
        extreme = None

    range_n = data.get("range_n")
    try:
        range_n = int(range_n) if range_n is not None else None
    except (TypeError, ValueError):
        range_n = None
    if range_n is not None:
        range_n = max(1, min(range_n, 10))

    order = str(data.get("range_order") or "asc").strip().lower()
    if order not in ("asc", "desc"):
        order = "asc"

    doc_hint = data.get("doc_hint")
    doc_hint = doc_hint.strip().upper() if isinstance(doc_hint, str) and doc_hint.strip() else None

    search_text = data.get("search_text")
    search_text = search_text.strip() if isinstance(search_text, str) and search_text.strip() else query

    # Защита от рассогласованного плана: если режим требует параметра, которого нет —
    # откатываемся к semantic, а не угадываем.
    if mode == "exact_article" and not article_nos:
        mode = "semantic"
    if mode == "extreme" and not extreme:
        mode = "semantic"
    if mode == "range" and not range_n:
        mode = "semantic"
    # Для extreme задаём согласованный order (first→asc, last→desc) — пригодится диспетчеру.
    if mode == "extreme":
        order = "asc" if extreme == "first" else "desc"

    return QueryPlan(
        mode=mode,
        unit=unit,
        article_nos=article_nos,
        extreme=extreme,
        range_n=range_n,
        range_order=order,
        doc_hint=doc_hint,
        search_text=search_text,
    )


def plan_query(query: str, history_context: str | None = None) -> QueryPlan:
    """Главная точка входа. Возвращает QueryPlan; при любой ошибке — semantic-план.

    history_context — текст последних реплик диалога. Передаётся, чтобы планировщик
    разрешал референсные продолжения («процитируй её» → exact_article по статье из
    предыдущего ответа). Вызываем LLM, если запрос структурный ИЛИ (есть история и
    запрос выглядит референсным).
    """
    q = (query or "").strip()
    if not q:
        return QueryPlan(mode="semantic", search_text="")

    use_context = bool(history_context) and _looks_referential(q)
    trigger = needs_planner(q) or use_context
    # Опциональный semantic-router добирает структурные перефразировки без триггер-слов.
    if not trigger and settings.rag_use_semantic_router:
        from services.rag.intent_router import is_structural

        if is_structural(q):
            trigger = True
    if not trigger:
        return QueryPlan(mode="semantic", search_text=q)

    user_msg = q
    if use_context:
        user_msg = (
            f"Контекст последних реплик диалога:\n{history_context}\n\n"
            f"Текущий запрос (разреши ссылки вроде «её/эту/ту статью» по контексту):\n{q}"
        )

    try:
        data = get_llm().generate_json(
            SYSTEM_PROMPT_PLANNER,
            user_msg,
            schema_hint='{"mode": "...", "unit": "article", "article_nos": [], '
            '"extreme": null, "range_n": null, "range_order": "asc", '
            '"doc_hint": null, "search_text": "..."}',
            grammar=_get_grammar() if settings.rag_planner_use_grammar else None,
        )
    except Exception as e:
        logger.warning("[PLANNER] LLM-план не получен: {}", e)
        return QueryPlan(mode="semantic", search_text=q)

    plan = _normalize(data, q)
    logger.info(
        "[PLANNER] mode={} unit={} article_nos={} extreme={} range_n={} order={} doc_hint={}",
        plan.mode, plan.unit, plan.article_nos, plan.extreme, plan.range_n,
        plan.range_order, plan.doc_hint,
    )
    return plan
