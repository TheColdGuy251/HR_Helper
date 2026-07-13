from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Callable, Iterator

from config import settings
from services.llm import get_llm
from services.llm.prompts import (
    SYSTEM_PROMPT_ATTACHMENT,
    SYSTEM_PROMPT_CHAT,
    SYSTEM_PROMPT_COMPARE,
    SYSTEM_PROMPT_DECOMPOSE,
    SYSTEM_PROMPT_HYDE,
    SYSTEM_PROMPT_QUERY_REWRITE,
    SYSTEM_PROMPT_RAG,
    SYSTEM_PROMPT_SELFCHECK,
    SYSTEM_PROMPT_SMALLTALK,
    SYSTEM_PROMPT_SUMMARY,
    SYSTEM_PROMPT_TOPIC,
    build_rag_prompt,
)
from services.rag.aliases import expand_abbreviations, expand_synonyms
from services.rag.planner import plan_query
from services.rag.spellfix import correct_typos
from services.rag.reranker import get_reranker
from services.rag.retriever import RetrievedChunk, get_retriever
from services.vectorstore import get_store
from utils.logger import logger


# Все словоформы «статья» (статьях, статьями, статью, статьёй …) + «ст.»
_EXACT_ARTICLE_ANCHOR_RE = re.compile(
    r"\b(?:стат\w*|ст\.?)\s+(?:номер\s+|№\s*)?(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
# Обратный порядок: «3 статью», «47 главу» — число ПЕРЕД словом.
# Появляется после нормализации «третью статью» → «3 статью».
_EXACT_ARTICLE_ANCHOR_REVERSE_RE = re.compile(
    r"\b(\d+(?:\.\d+)?)\s+(?:стат\w*|ст\.)",
    re.IGNORECASE,
)
# После найденного номера в небольшом окне — дополнительные через «, и или»
_EXTRA_NUMBER_RE = re.compile(
    r"(?:[,;]|\sи\s|\sили\s)\s*(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)


# Порядковые числительные («сорок седьмая статья»), «первая/последняя статья» и
# каталожные «первые N статей» теперь распознаёт планировщик (services/rag/planner.py),
# а не таблицы регэкспов. Здесь остались лишь точечные хелперы для safety-net и fallback.

# Для парсинга номера из заголовка чанка «Статья 81. …»
_ARTICLE_HEADER_RE = re.compile(r"^\s*стать[яеи]?\s+(\d+(?:\.\d+)?)", re.IGNORECASE)

# Маркер чанка-продолжения длинной статьи: «[Статья 81. … — продолжение] …»
_CONT_TAG_RE = re.compile(r"^\[[^\]]*—\s*продолжение\]\s*", re.IGNORECASE)


def _extract_article_numbers(query: str) -> list[str]:
    """Возвращает все номера статей из запроса.
    Поддерживает:
      - «статья 81», «ст. 192», «статья 84.1», «статья номер 5», «ст. №3»
      - обратный порядок (после нормализации числительных): «3 статью», «47 ст.»
      - словоформы: статья, статьи, статью, статьях, статьями, статьёй, статей
      - перечисления: «статьи 80, 81 и 82», «о статьях 34 и 57», «ст. 192 и 193».
    """
    q = query or ""
    out: list[str] = []

    # Прямой порядок: «статья N» + добор «, и N» в окне справа
    for anchor in _EXACT_ARTICLE_ANCHOR_RE.finditer(q):
        if anchor.group(1) not in out:
            out.append(anchor.group(1))
        tail = q[anchor.end() : anchor.end() + 80]
        for m in _EXTRA_NUMBER_RE.finditer(tail):
            num = m.group(1)
            if re.search(r"\b(?:год|глав|пункт|раздел|часть|кварт)\w*", tail[: m.start()], re.IGNORECASE):
                break
            if num not in out:
                out.append(num)

    # Обратный порядок: «N статью» — типичный результат нормализации
    for anchor in _EXACT_ARTICLE_ANCHOR_REVERSE_RE.finditer(q):
        num = anchor.group(1)
        if num not in out:
            out.append(num)

    return out
# Сравнение: проверяем наличие «сравни/разниц/отлич/противопостав…» И связки «и/с/от/против/vs»
_COMPARE_TRIGGER = re.compile(
    r"сравн\w*|разниц\w*|различ\w*|отлич\w*|противопостав\w*", re.IGNORECASE
)
_COMPARE_CONNECTOR = re.compile(
    r"\s+(?:и|с|от|против|vs)\s+", re.IGNORECASE
)


def _is_compare_query(q: str) -> bool:
    return bool(_COMPARE_TRIGGER.search(q) and _COMPARE_CONNECTOR.search(q))


# Отрицания: «не выплатить», «нельзя», «запрещено», «без согласия»
_NEGATION_RE = re.compile(
    r"\b(не\s+\w{2,}|нельзя|запрещ\w+|без\s+\w{2,}|невозможн\w+|невыпла\w+|неоплач\w+)",
    re.IGNORECASE,
)


def _has_negation(q: str) -> bool:
    return bool(_NEGATION_RE.search(q or ""))


# Болтовня/благодарности/приветствия: их нельзя гнать через RAG — иначе на «спасибо»
# идёт поиск, а query-rewrite может выдумать левую тему. Считаем сообщение болтовнёй,
# только если есть социальный маркер И нет признаков информационного запроса.
_GREET_RE = re.compile(
    r"\b(спасибо|благодар|спс|пожалуйста|привет|здравствуй|здаров|добрый день|"
    r"добрый вечер|доброе утро|пока|до свидания|всего доброго|увидимся|"
    r"понял|поняла|понятно|ясно|ок|окей|хорошо|ладно|круто|отлично|супер|класс)\b",
    re.IGNORECASE,
)
# ВАЖНО: «?» здесь НЕ признак информационного запроса — иначе любое приветствие
# с вопросительным знаком («Привет, это кто?») уходило в RAG и получало шаблонный
# отказ «в выдержках нет информации» вместо живого ответа.
_INFO_RE = re.compile(
    r"\b(расскажи|объясни|подскажи|сравни|покажи|найди|перечисли|опиши|дай|"
    r"сформулируй|как |какой|какая|какие|сколько|когда|где|почему|зачем|"
    r"можно ли|нужно|вправе|обязан|стать|пункт|раздел|глав|договор|отпуск|"
    r"увольн|уволи|приём|прием|зарплат|оклад|преми|кодекс|закон|норм|срок|"
    r"документ|оформ|порядок|право|гарант)\b",
    re.IGNORECASE,
)

# Вопрос про новости HR-отдела («какие новости», «что нового», «анонсы», «дайджест»)
# → отвечаем из ленты /news (последние посты подмешиваем в контекст LLM).
_NEWS_RE = re.compile(
    r"\b(новост\w*|анонс\w*|дайджест\w*|объявлени\w*)\b|что\s+нового|что\s+новенького",
    re.IGNORECASE,
)

# Запрос «выдай/дай бланк/образец/шаблон/форму заявления …» → отдаём файл(ы) напрямую
# карточками, без длинного RAG-ответа по нормативке (протокол: бот ВЫДАЁТ бланк).
_BLANK_RE = re.compile(
    r"\b(бланк\w*|образ(?:ец|цы|ца|цов)|шаблон\w*)\b"
    r"|\b(выдай|дай|дать|нужн\w+|скачать|пришл\w+|предостав\w+|получить|хочу)\b"
    r"[^.]{0,40}\b(заявлени\w*|записк\w*|форм\w*|документ\w*)\b",
    re.IGNORECASE,
)

# Социальные вопросы о самом ассистенте («это кто?», «ты бот?», «что умеешь?») —
# разговорный ответ без поиска по базе знаний.
_SOCIAL_RE = re.compile(
    r"\b(кто\s+ты|ты\s+кто|это\s+кто|кто\s+это|как\s+тебя\s+зовут|ты\s+бот|"
    r"ты\s+человек|ты\s+робот|что\s+ты\s+умеешь|что\s+умеешь|чем\s+можешь\s+помочь|"
    r"чем\s+поможешь|как\s+дела|как\s+ты|что\s+делаешь)\b",
    re.IGNORECASE,
)


def _is_smalltalk(query: str) -> bool:
    q = (query or "").strip()
    if not q or len(q) > 160:
        return False
    if _SOCIAL_RE.search(q):
        return True
    return bool(_GREET_RE.search(q)) and not _INFO_RE.search(q)


# Короткие уточняющие продолжения по той же теме: «а подробнее?», «процитируй её»,
# «покажи целиком», «а что там про сроки». В диалоге с историей их НЕЛЬЗЯ гасить как
# «нетематический мусор» — иначе поиск не идёт, источники не подтягиваются, а модель
# ссылается на статьи «по памяти» из прошлых реплик (баг: ответ со ссылками, но без
# блока «Источники»). Здесь требуем явный маркер продолжения, а не просто короткую длину.
_FOLLOWUP_MARKER_RE = re.compile(
    r"\b(её|ее|неё|нее|его|них|это|этот|эту|этой|этом|там|туда|выше|тут|здесь)\b"
    r"|подробн|целиком|полност|дальше|продолж|процитир|разверн|раскрой"
    r"|\bа\s+(что|как|где|когда|почему|зачем|если)\b|ещё|\bеще\b",
    re.IGNORECASE,
)


def _is_followup(query: str, history: list[dict] | None) -> bool:
    q = (query or "").strip()
    if not history or not q or len(q) > 80:
        return False
    return bool(_FOLLOWUP_MARKER_RE.search(q))


# Арифметика/числа («1+1», «2*3=»), пустой набор символов.
_ARITHMETIC_RE = re.compile(r"^[\d\s+\-*/=^%.,()]+$")


def _looks_nonknowledge(query: str) -> bool:
    """Тривиальные/общие/мусорные запросы («1+1», «вавыы», короткая болтовня),
    которые НЕ требуют документов. Их нельзя гнать через RAG-отказ «нет в базе» —
    нужно отвечать обычным чатом (#13)."""
    q = (query or "").strip()
    if not q:
        return False
    if _ARITHMETIC_RE.match(q):
        return True
    # Явный признак информационного/HR-запроса → это НЕ мусор, не трогаем.
    if _INFO_RE.search(q):
        return False
    if _extract_article_numbers(q):
        return False
    # Короткая фраза без единого осмысленного сигнала → болтовня/мусор → обычный чат.
    if len(q) <= 40:
        return True
    return False


@dataclass
class RAGResult:
    answer_stream: Iterator[str]
    sources: list[dict] = field(default_factory=list)
    used_subqueries: list[str] = field(default_factory=list)
    # Тексты чанков, ушедших в контекст LLM — для self-check ответа по источникам.
    context_texts: list[str] = field(default_factory=list)
    # А3: контактное лицо подразделения (из совпавшей FAQ-записи) — уходит
    # в футер ответа вместе с дисклеймером. None — контакт неизвестен.
    contact: str | None = None
    # А2: связанные бланки/документы FAQ, сопоставленные с реальными файлами —
    # кликабельные карточки «Скачать» под ответом. [{title, kind, url, view_url}]
    related_files: list[dict] = field(default_factory=list)


class RAGPipeline:
    _ATTACHMENT_MAX_CHARS = 6000        # лимит на один передаваемый фрагмент
    _ATTACHMENT_MAX_CHUNKS = 4          # сколько фрагментов вложения отдать в контекст
    _KB_SUPPORT_WITH_ATTACHMENT = 2     # сколько KB-выдержек оставить как подкрепление

    # Обзорные запросы по документу: «перескажи / о чём / суть / содержание / резюме».
    _OVERVIEW_RE = re.compile(
        r"(переска\w+|кратк\w+|вкратц\w+|о\s+ч[её]м|содержани\w+|суть|резюм\w+|"
        r"summary|обзор|главн\w+\s+мысл|основн\w+\s+(?:мысл|положени|идеи))",
        re.IGNORECASE,
    )

    def __init__(self):
        self.retriever = get_retriever()
        self.reranker = get_reranker()
        self.llm = get_llm()

    # ---------------------------------------------------------------
    # HyDE / decomposition / summary
    # ---------------------------------------------------------------

    def _maybe_hyde(self, query: str) -> str:
        """Готовит поисковый запрос: расширяет аббревиатуры (ТК→Трудовой кодекс) и
        разговорные синонимы (заболел→временная нетрудоспособность). При включённом
        HyDE дополнительно дописывает гипотетический параграф."""
        query = expand_synonyms(expand_abbreviations(query))
        if not settings.rag_use_hyde:
            return query
        if len(query) > settings.rag_hyde_max_query_chars:
            return query
        try:
            hyde = self.llm.generate_text(
                SYSTEM_PROMPT_HYDE, query, max_tokens=120, temperature=0.2
            )
        except Exception as e:
            logger.warning("HyDE failed: {}", e)
            return query
        if not hyde:
            return query
        logger.info("[RAG] HyDE → +{} chars", len(hyde))
        return f"{query}\n{hyde}"

    def _maybe_decompose(self, query: str) -> list[str]:
        """Разбиваем сложный вопрос на 1–N подвопросов.
        Сравнительные запросы («сравни X и Y», «разница X и Y») всегда декомпозируются
        — для них семантический поиск одним вектором плохо работает."""
        if _is_compare_query(query):
            # Принудительно декомпозируем — пусть LLM выдаст подвопросы про X и про Y
            try:
                raw = self.llm.generate_text(
                    SYSTEM_PROMPT_DECOMPOSE, expand_abbreviations(query),
                    max_tokens=180, temperature=0.0,
                )
                m = re.search(r"\[.*?\]", raw, re.DOTALL)
                if m:
                    sub = json.loads(m.group(0))
                    if isinstance(sub, list) and sub:
                        sub = [str(s).strip() for s in sub if isinstance(s, str) and s.strip()]
                        if len(sub) >= 2:
                            logger.info("[RAG] compare-query → {} subqueries", len(sub))
                            return sub[: settings.rag_decomposition_max]
            except Exception as e:
                logger.warning("compare decomposition failed: {}", e)
        if not settings.rag_use_decomposition:
            return [query]
        # Эвристика: дробим ТОЛЬКО реально много-составные вопросы. Раньше триггером
        # была любая запятая/«и» → одно-интентные вопросы дробились на узкие подвопросы,
        # притягивая нерелевантные статьи (шум). Теперь нужен явный сигнал: два вопроса
        # «?», либо перечислительные связки «а также / кроме того / и ещё / наряду».
        if len(query) < 35:
            return [query]
        if not re.search(
            r"\?.*\?|\sа также\s|\sкроме того\s|\sи ещё\s|\sи еще\s|\sнаряду\s|перечисл",
            query, re.IGNORECASE,
        ):
            return [query]
        try:
            raw = self.llm.generate_text(
                SYSTEM_PROMPT_DECOMPOSE, query, max_tokens=180, temperature=0.0
            )
            # Вырезаем JSON-массив из ответа
            m = re.search(r"\[.*?\]", raw, re.DOTALL)
            if not m:
                return [query]
            sub = json.loads(m.group(0))
            if not isinstance(sub, list):
                return [query]
            sub = [str(s).strip() for s in sub if isinstance(s, str) and s.strip()]
            if not sub:
                return [query]
            sub = sub[: settings.rag_decomposition_max]
            logger.info("[RAG] decomposition → {} subqueries", len(sub))
            return sub
        except Exception as e:
            logger.warning("decomposition failed: {}", e)
            return [query]

    def _maybe_rewrite_query(self, query: str) -> str:
        """Если запрос содержит отрицания — переформулируем через LLM в утвердительную форму
        (эмбеддинги плохо обрабатывают NOT). Aliases уже расширены в _maybe_hyde."""
        if not _has_negation(query):
            return query
        try:
            rewritten = self.llm.generate_text(
                SYSTEM_PROMPT_QUERY_REWRITE, query, max_tokens=120, temperature=0.0
            )
            rewritten = (rewritten or "").strip().strip('«»"\'').rstrip(".").strip()
            if rewritten and len(rewritten) >= 5:
                logger.info("[RAG] rewrite: '{}' → '{}'", query[:60], rewritten[:60])
                # Конкатенируем оригинал и переписанное: BM25 ищет по терминам исходника,
                # dense ловит семантику расширенной формы.
                return f"{query}\n{rewritten}"
        except Exception as e:
            logger.warning("query rewrite failed: {}", e)
        return query

    def _classify_topics(self, query: str) -> list[str]:
        """Возвращает до 3 тем для query (для тегов-приоритизации в Qdrant)."""
        try:
            raw = self.llm.generate_text(
                SYSTEM_PROMPT_TOPIC, query, max_tokens=60, temperature=0.0
            )
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                return []
            data = json.loads(m.group(0))
            topics = data.get("topics") or []
            if not isinstance(topics, list):
                return []
            return [str(t).strip() for t in topics if isinstance(t, str) and t.strip()][:3]
        except Exception as e:
            logger.warning("topic classification failed: {}", e)
            return []

    def summarize_history(self, messages: list[dict]) -> str:
        """Свести список {role, content} в краткую сводку (для memory)."""
        if not messages:
            return ""
        body = "\n".join(
            f"{'Пользователь' if m['role'] == 'user' else 'Ассистент'}: {m['content']}"
            for m in messages
        )
        # ограничим длину входа
        body = body[:6000]
        try:
            return self.llm.generate_text(
                SYSTEM_PROMPT_SUMMARY, body, max_tokens=300, temperature=0.0
            )
        except Exception as e:
            logger.warning("summary failed: {}", e)
            return ""

    def self_check(self, question: str, answer: str, sources_texts: list[str]) -> dict:
        """Проверка соответствия ответа источникам. Возвращает {supported, total, issues}."""
        if not sources_texts or not answer.strip():
            return {}
        body = (
            f"Вопрос: {question}\n\n"
            f"Ответ ассистента:\n{answer}\n\n"
            f"Источники:\n" + "\n---\n".join(s[:1500] for s in sources_texts[:3])
        )
        raw = self.llm.generate_text(
            SYSTEM_PROMPT_SELFCHECK, body, max_tokens=200, temperature=0.0
        )
        try:
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                return {}
            data = json.loads(m.group(0))
            return {
                "supported": int(data.get("supported", 0)),
                "total": int(data.get("total", 0)) or 1,
                "issues": list(data.get("issues") or [])[:5],
            }
        except Exception as e:
            logger.warning("self-check parse failed: {}", e)
            return {}

    # ---------------------------------------------------------------
    # Retrieval
    # ---------------------------------------------------------------

    def _expand_with_linked_articles(
        self, chunks: list[RetrievedChunk], max_extra: int = 3
    ) -> list[RetrievedChunk]:
        """По графу kb_links добираем статьи, на которые ссылаются найденные чанки.
        Помогает на вопросах вида «расскажи про ст. 81» — модель получает не только саму
        ст. 81, но и ст. 192, на которую она ссылается."""
        if not chunks:
            return chunks
        try:
            from data.db_session import create_session
            from data.kb_links import KBLink

            source_doc_ids = {c.document_id for c in chunks if c.document_id is not None}
            source_chunk_idx = {c.chunk_index for c in chunks if c.chunk_index is not None}
            if not source_doc_ids:
                return chunks

            db = create_session()
            try:
                links = (
                    db.query(KBLink)
                    .filter(
                        KBLink.from_doc_id.in_(source_doc_ids),
                        KBLink.from_chunk_index.in_(source_chunk_idx),
                        KBLink.target_kind == "article",
                    )
                    .limit(max_extra * 3)
                    .all()
                )
            finally:
                db.close()

            if not links:
                return chunks

            # Достаём чанки целевых статей (без рерэнка)
            from services.rag.chunker import parse_article_no

            # Номера УЖЕ найденных статей: ссылка «на себя» (заголовок статьи в
            # старых kb_links) не должна подтягивать чужие статьи через префикс.
            source_nos = {parse_article_no(c.text) for c in chunks} - {None}
            extra: list[RetrievedChunk] = []
            already = {(c.document_id, c.chunk_index) for c in chunks}
            seen_articles: set[str] = set()
            for link in links:
                if link.target_number in seen_articles:
                    continue
                try:
                    if float(link.target_number) in source_nos:
                        continue  # самоссылка — пропускаем
                except ValueError:
                    pass
                seen_articles.add(link.target_number)
                got = self._exact_article_retrieve([link.target_number])
                for g in got:
                    if (g.document_id, g.chunk_index) in already:
                        continue
                    g.score *= 0.9  # связанные слегка ниже основных
                    extra.append(g)
                    already.add((g.document_id, g.chunk_index))
                if len(extra) >= max_extra:
                    break
            if extra:
                logger.info("[RAG] link-expansion: +{} связанных статей", len(extra))
            return chunks + extra[:max_extra]
        except Exception as e:
            logger.warning("link-expansion failed: {}", e)
            return chunks

    @staticmethod
    def _merge_article_chunks(chunks: list[RetrievedChunk]) -> list[RetrievedChunk]:
        """Склеивает чанки одной статьи (голова + «— продолжение») в ЦЕЛЬНЫЙ текст:
        снимает маркер продолжения и срезает дублирующееся перекрытие чанкера.
        Иначе модель видит «фрагменты» с обрывом посреди слова и отказывается
        цитировать статью («полный текст не приведён»), хотя он весь в контексте."""
        out: list[RetrievedChunk] = []
        for c in chunks:
            m = _CONT_TAG_RE.match(c.text or "")
            prev = out[-1] if out else None
            if (
                m
                and prev is not None
                and prev.document_id == c.document_id
                and prev.chunk_index is not None
                and c.chunk_index == (prev.chunk_index or 0) + 1
            ):
                cont = c.text[m.end():]
                # Перекрытие: конец головы дословно повторяется в начале продолжения
                # (chunk_overlap символов, часто с обрывом слова) — ищем стык.
                max_ov = min(len(prev.text), len(cont), settings.chunk_overlap + 80)
                joined = None
                for k in range(max_ov, 19, -1):
                    if prev.text.endswith(cont[:k]):
                        joined = prev.text + cont[k:]
                        break
                prev.text = joined if joined is not None else f"{prev.text}\n{cont}"
                prev.chunk_index = c.chunk_index  # для склейки следующего продолжения
                continue
            out.append(c)
        return out

    def _exact_article_retrieve(self, article_nos: list[str]) -> list[RetrievedChunk]:
        """Прямая выборка чанков, начинающихся со «Статья N.».
        Возвращает все найденные продолжения той же статьи (если они есть)."""
        store = get_store()
        out: list[RetrievedChunk] = []
        # Лимит сознательно небольшой: «Статья 1.» встречается во многих документах
        # (каждый ЛНА начинается со «Статья 1.»), без лимита prompt раздувается до
        # 3-4 тысяч токенов → prefill 1.5+ минуты на CPU.
        for n in article_nos:
            # digit_boundary: «статья 28» не должна цеплять «Статья 280»/«28.1».
            prefix = f"статья {n}".lower()
            hits = store.fetch_chunks_by_text_prefix(prefix, limit=4, digit_boundary=True)
            # Также подтягиваем чанки-продолжения с маркером [Статья N. … — продолжение]
            cont_hits = store.fetch_chunks_by_text_prefix(
                f"[статья {n}".lower(), limit=4, digit_boundary=True
            )
            for h in hits + cont_hits:
                out.append(
                    RetrievedChunk(
                        text=h.text,
                        score=1.0,
                        document_id=h.document_id,
                        chunk_index=(h.payload or {}).get("chunk_index"),
                        title=(h.payload or {}).get("title", ""),
                        source_uri=(h.payload or {}).get("source_uri", ""),
                        source_type=(h.payload or {}).get("source_type", ""),
                        priority=int((h.payload or {}).get("priority", 2) or 2),
                    )
                )
        # Дедуп по chunk_id + сортировка
        seen: set = set()
        uniq: list[RetrievedChunk] = []
        for c in out:
            key = (c.document_id, c.chunk_index, c.text[:60])
            if key in seen:
                continue
            seen.add(key)
            uniq.append(c)
        uniq.sort(key=lambda c: (c.document_id or 0, c.chunk_index or 0))
        return self._merge_article_chunks(uniq)

    def _find_extreme_article_number(self, kind: str) -> str | None:
        """Сканирует индекс, ищет все заголовки «Статья N.», возвращает
        минимальный (kind='first') или максимальный (kind='last') номер
        как строку. Десятичные («84.1») сравниваются по float.

        Возвращает None, если в индексе нет распознанных заголовков статей.
        """
        store = get_store()
        # Большой лимит — сканируем всё, что начинается со «статья »
        hits = store.fetch_chunks_by_text_prefix("статья ", limit=10000)
        nums: list[tuple[float, str]] = []
        for h in hits:
            m = _ARTICLE_HEADER_RE.match(h.text or "")
            if not m:
                continue
            raw = m.group(1)
            try:
                nums.append((float(raw), raw))
            except ValueError:
                continue
        if not nums:
            return None
        nums.sort(key=lambda x: x[0])
        chosen = nums[0] if kind == "first" else nums[-1]
        return chosen[1]

    def _list_query_retrieve(
        self, query: str, n: int, order: str
    ) -> list[RetrievedChunk]:
        """Каталожный запрос: находим самый релевантный документ и возвращаем
        его первые/последние N чанков в порядке chunk_index."""
        try:
            # Шаг 1: ищем релевантный документ через обычный dense-поиск (top-1)
            qvec = self.retriever.encoder.encode_one(query, is_query=True)
            hits = self.retriever.store.search(qvec, top_k=5)
            if not hits:
                return []
            # Голосуем за документ: какой document_id чаще встречается среди топ-5
            from collections import Counter
            doc_votes = Counter(h.document_id for h in hits if h.document_id is not None)
            if not doc_votes:
                return []
            doc_id, _ = doc_votes.most_common(1)[0]

            # Шаг 2: берём первые/последние N чанков этого документа в порядке chunk_index
            chunks = get_store().fetch_document_chunks(doc_id, limit=n, order=order)
            result: list[RetrievedChunk] = []
            for h in chunks:
                result.append(
                    RetrievedChunk(
                        text=h.text,
                        score=1.0,
                        document_id=h.document_id,
                        chunk_index=(h.payload or {}).get("chunk_index"),
                        title=(h.payload or {}).get("title", ""),
                        source_uri=(h.payload or {}).get("source_uri", ""),
                        source_type=(h.payload or {}).get("source_type", ""),
                        priority=int((h.payload or {}).get("priority", 2) or 2),
                    )
                )
            return result
        except Exception as e:
            logger.warning("list-query retrieve failed: {}", e)
            return []

    # ---------------------------------------------------------------
    # Metadata-режимы (по article_no/is_article_head) — для планировщика
    # ---------------------------------------------------------------

    @staticmethod
    def _fmt_article_no(n: float) -> str:
        """81.0 → '81', 84.1 → '84.1' (для текстовых fallback-методов)."""
        return str(int(n)) if float(n).is_integer() else str(n)

    @staticmethod
    def _hit_to_chunk(h, score: float = 1.0) -> RetrievedChunk:
        pay = h.payload or {}
        return RetrievedChunk(
            text=h.text,
            score=score,
            document_id=h.document_id,
            chunk_index=pay.get("chunk_index"),
            title=pay.get("title", ""),
            source_uri=pay.get("source_uri", ""),
            source_type=pay.get("source_type", ""),
            priority=int(pay.get("priority", 2) or 2),
        )

    def _pick_relevant_document(self, query: str) -> int | None:
        """Голосование топ-5 dense-хитов за document_id — чтобы extreme/range
        привязать к одному документу («последняя статья ТК», а не по всей базе)."""
        try:
            from collections import Counter

            qvec = self.retriever.encoder.encode_one(query, is_query=True)
            hits = self.retriever.store.search(qvec, top_k=5)
            votes = Counter(h.document_id for h in hits if h.document_id is not None)
            return votes.most_common(1)[0][0] if votes else None
        except Exception as e:
            logger.warning("doc-pick failed: {}", e)
            return None

    def _articles_chunks(
        self, pairs: list[tuple[float, int | None]]
    ) -> list[RetrievedChunk]:
        """По списку (article_no, document_id) собирает все чанки этих статей через
        индекс article_no (без скана)."""
        store = get_store()
        out: list[RetrievedChunk] = []
        seen: set = set()
        for no, did in pairs:
            for h in store.fetch_chunks_by_article_no(no, document_id=did, limit=8):
                key = (h.document_id, (h.payload or {}).get("chunk_index"))
                if key in seen:
                    continue
                seen.add(key)
                out.append(self._hit_to_chunk(h))
        return out

    def _exact_article_by_meta(
        self, article_nos: list[float], document_id: int | None = None
    ) -> list[RetrievedChunk]:
        return self._merge_article_chunks(
            self._articles_chunks([(n, document_id) for n in article_nos])
        )

    @staticmethod
    def _resolve_doc_hint(doc_hint: str | None) -> int | None:
        """«ТК»/«ГК»/«Трудовой кодекс» → document_id. Аббревиатуру расширяем через
        aliases, затем ищем по title/source_uri индексированного документа.
        Если совпадения нет — None (диспетчер откатится к семантическому выбору)."""
        if not doc_hint:
            return None
        try:
            from sqlalchemy import func, or_

            from data.db_session import create_session
            from data.kb_documents import KBDocument
            from services.rag.aliases import ABBREVIATIONS

            hint = doc_hint.strip()
            full = ABBREVIATIONS.get(hint.upper()) or ABBREVIATIONS.get(hint) or hint
            needles = {hint.lower(), full.lower()}

            db = create_session()
            try:
                q = db.query(KBDocument).filter(KBDocument.status == "indexed")
                conds = []
                for n in needles:
                    like = f"%{n}%"
                    conds.append(func.lower(KBDocument.title).like(like))
                    conds.append(func.lower(KBDocument.source_uri).like(like))
                doc = q.filter(or_(*conds)).first()
                return doc.id if doc else None
            finally:
                db.close()
        except Exception as e:
            logger.warning("doc-hint resolve failed: {}", e)
            return None

    @classmethod
    def _structure_note(
        cls, doc_title: str, first_no: float, last_no: float, text: str
    ) -> RetrievedChunk:
        """Синтетический чанк с ДЕТЕРМИНИРОВАННЫМ фактом о структуре документа.
        Нужен, потому что в обычных выдержках нет признака «это последняя статья» —
        и системный промпт справедливо отказывается угадывать. Факт вычислен по
        индексу (article_no), не галлюцинация, поэтому даём его модели как источник."""
        return RetrievedChunk(
            text=text,
            score=99.0,  # всегда первым в контексте
            document_id=None,
            chunk_index=None,
            title=f"Структура документа «{doc_title}» (определено системой)",
            source_uri="system",
            source_type="system",
            priority=2,
        )

    def _head_chunk(self, no: float, did: int | None) -> RetrievedChunk | None:
        """Только заголовок статьи (первый чанк) — для extreme/range достаточно,
        чтобы назвать статью, и резко уменьшает промпт (быстрее prefill на CPU)."""
        cs = get_store().fetch_chunks_by_article_no(no, document_id=did, limit=1)
        return self._hit_to_chunk(cs[0]) if cs else None

    def _heads_for(
        self, query: str, doc_hint: str | None = None
    ) -> list[tuple[float, int | None]]:
        store = get_store()
        # Документ по явной подсказке («ТК») приоритетнее семантического выбора.
        doc_id = self._resolve_doc_hint(doc_hint) or self._pick_relevant_document(query)
        heads = store.fetch_article_heads(document_id=doc_id)
        if not heads and doc_id is not None:
            heads = store.fetch_article_heads()  # глобальный fallback
        return heads

    def _extreme_article_by_meta(
        self, extreme: str, query: str, doc_hint: str | None = None
    ) -> list[RetrievedChunk]:
        """«Первая/последняя статья»: по заголовкам статей берём min/max номер,
        отдаём справку о структуре + заголовок этой статьи."""
        heads = self._heads_for(query, doc_hint)
        if not heads:
            return []
        first_no = heads[0][0]
        last_no, last_doc = heads[-1]
        first_doc = heads[0][1]
        target_no, target_doc = (first_no, first_doc) if extreme == "first" else (last_no, last_doc)
        head = self._head_chunk(target_no, target_doc)
        if head is None:
            return []
        which = "первая" if extreme == "first" else "последняя"
        note_text = (
            f"По структуре документа определено: статьи нумеруются с "
            f"{self._fmt_article_no(first_no)} по {self._fmt_article_no(last_no)}. "
            f"Таким образом, {which} статья — Статья {self._fmt_article_no(target_no)}. "
            f"Её заголовок и начало текста приведены ниже."
        )
        note = self._structure_note(head.title or "документ", first_no, last_no, note_text)
        return [note, head]

    def _range_articles_by_meta(
        self, n: int, order: str, query: str, doc_hint: str | None = None
    ) -> list[RetrievedChunk]:
        """«Первые/последние N статей»: справка + заголовки выбранных статей."""
        heads = self._heads_for(query, doc_hint)
        if not heads:
            return []
        first_no, last_no = heads[0][0], heads[-1][0]
        chosen = heads[:n] if order == "asc" else heads[-n:]
        chosen.sort(key=lambda x: x[0])  # естественный возрастающий порядок
        out: list[RetrievedChunk] = []
        for no, did in chosen:
            head = self._head_chunk(no, did)
            if head is not None:
                out.append(head)
        if not out:
            return []
        which = "первые" if order == "asc" else "последние"
        nums = ", ".join(self._fmt_article_no(no) for no, _ in chosen)
        note_text = (
            f"По структуре документа определено: статьи нумеруются с "
            f"{self._fmt_article_no(first_no)} по {self._fmt_article_no(last_no)}. "
            f"Запрошены {which} {len(out)} статей: {nums}. Их заголовки приведены ниже."
        )
        note = self._structure_note(out[0].title or "документ", first_no, last_no, note_text)
        return [note] + out

    def _count_articles(
        self, query: str, doc_hint: str | None = None
    ) -> list[RetrievedChunk]:
        """Богатая справка о количестве статей — чтобы модель отвечала на семейство
        вопросов (всего / без подстатей / сколько подстатей / диапазон), а не на один
        шаблон. Считаем по уникальным номерам заголовков (article_no)."""
        heads = self._heads_for(query, doc_hint)
        if not heads:
            return []
        nos = sorted({no for no, _ in heads})
        main = [n for n in nos if float(n).is_integer()]   # 81, 82 …
        sub = [n for n in nos if not float(n).is_integer()]  # 84.1, 22.2 …
        sample = self._head_chunk(nos[0], None)
        title = sample.title if sample else "документ"
        rng = (
            f"с {self._fmt_article_no(main[0])} по {self._fmt_article_no(main[-1])}"
            if main else f"с {self._fmt_article_no(nos[0])} по {self._fmt_article_no(nos[-1])}"
        )
        note_text = (
            "По структуре документа определено (по заголовкам «Статья N»):\n"
            f"- всего пронумерованных статей: {len(nos)};\n"
            f"- основных статей (целые номера, {rng}): {len(main)};\n"
            f"- дополнительных статей-подстатей (вида 84.1, 22.2): {len(sub)}.\n"
            "Используй эти числа: «сколько всего» = всего; «без подстатей»/«основных» = "
            "основных; «сколько подстатей» = дополнительных."
        )
        lo, hi = (main[0] if main else nos[0]), (main[-1] if main else nos[-1])
        return [self._structure_note(title, lo, hi, note_text)]

    # ---------------------------------------------------------------
    # Обобщённая навигация по единицам (раздел/глава/пункт/§) — не «Статья»
    # ---------------------------------------------------------------
    # (first_adj, last_adj, именительный ед.ч., родительный мн.ч.)
    _UNIT_WORDS = {
        "article": ("первая", "последняя", "статья", "статей"),
        "section": ("первый", "последний", "раздел", "разделов"),
        "chapter": ("первая", "последняя", "глава", "глав"),
        "clause": ("первый", "последний", "пункт", "пунктов"),
        "paragraph": ("первый", "последний", "параграф", "параграфов"),
    }

    def _unit_heads_for(
        self, unit: str, query: str, doc_hint: str | None = None
    ) -> list[tuple[str, float, int | None]]:
        store = get_store()
        doc_id = self._resolve_doc_hint(doc_hint) or self._pick_relevant_document(query)
        heads = store.fetch_unit_heads(unit, document_id=doc_id)
        if not heads and doc_id is not None:
            heads = store.fetch_unit_heads(unit)
        return heads

    def _exact_units_by_meta(
        self, unit: str, nos: list[float], document_id: int | None = None
    ) -> list[RetrievedChunk]:
        store = get_store()
        out: list[RetrievedChunk] = []
        seen: set = set()
        for n in nos:
            for h in store.fetch_chunks_by_unit(
                unit, self._fmt_article_no(n), document_id=document_id, limit=8
            ):
                key = (h.document_id, (h.payload or {}).get("chunk_index"))
                if key in seen:
                    continue
                seen.add(key)
                out.append(self._hit_to_chunk(h))
        return out

    def _extreme_unit_by_meta(
        self, unit: str, extreme: str, query: str, doc_hint: str | None = None
    ) -> list[RetrievedChunk]:
        heads = self._unit_heads_for(unit, query, doc_hint)
        if not heads:
            return []
        no_str, _o, doc = heads[0] if extreme == "first" else heads[-1]
        cs = get_store().fetch_chunks_by_unit(unit, no_str, document_id=doc, limit=1)
        if not cs:
            return []
        head = self._hit_to_chunk(cs[0])
        first_a, last_a, noun, _gen = self._UNIT_WORDS.get(unit, ("первый", "последний", unit, unit))
        which = first_a if extreme == "first" else last_a
        note_text = (
            f"По структуре документа определено: единицы «{noun}» нумеруются с "
            f"{heads[0][0]} по {heads[-1][0]}. Таким образом, {which} {noun} — "
            f"{noun.capitalize()} {no_str}. Заголовок приведён ниже."
        )
        note = self._structure_note(head.title or "документ", 0.0, 0.0, note_text)
        return [note, head]

    def _range_units_by_meta(
        self, unit: str, n: int, order: str, query: str, doc_hint: str | None = None
    ) -> list[RetrievedChunk]:
        heads = self._unit_heads_for(unit, query, doc_hint)
        if not heads:
            return []
        chosen = heads[:n] if order == "asc" else heads[-n:]
        chosen = sorted(chosen, key=lambda x: x[1])
        out: list[RetrievedChunk] = []
        for no_str, _o, doc in chosen:
            cs = get_store().fetch_chunks_by_unit(unit, no_str, document_id=doc, limit=1)
            if cs:
                out.append(self._hit_to_chunk(cs[0]))
        if not out:
            return []
        _fa, _la, _noun, gen = self._UNIT_WORDS.get(unit, ("первый", "последний", unit, unit))
        which = "первые" if order == "asc" else "последние"
        nums = ", ".join(no for no, _o, _d in chosen)
        note_text = (
            f"Запрошены {which} {len(out)} {gen}: {nums}. Заголовки приведены ниже."
        )
        note = self._structure_note(out[0].title or "документ", 0.0, 0.0, note_text)
        return [note] + out

    def _count_units(
        self, unit: str, query: str, doc_hint: str | None = None
    ) -> list[RetrievedChunk]:
        heads = self._unit_heads_for(unit, query, doc_hint)
        if not heads:
            return []
        distinct = len({no for no, _o, _d in heads})
        _fa, _la, _noun, gen = self._UNIT_WORDS.get(unit, ("первый", "последний", unit, unit))
        cs = get_store().fetch_chunks_by_unit(unit, heads[0][0], document_id=heads[0][2], limit=1)
        title = cs[0].payload.get("title", "документ") if cs else "документ"
        note_text = (
            f"По структуре документа определено: всего {gen} — {distinct} "
            f"(нумерация с {heads[0][0]} по {heads[-1][0]})."
        )
        return [self._structure_note(title, 0.0, 0.0, note_text)]

    @staticmethod
    def _history_context(history: list[dict] | None, max_turns: int = 2) -> str:
        """Текст последних реплик для разрешения референсных follow-up-запросов
        («процитируй её»). Берём последние max_turns пар, обрезаем по длине."""
        if not history:
            return ""
        recent = history[-(max_turns * 2):]
        lines: list[str] = []
        for m in recent:
            role = "Пользователь" if m.get("role") == "user" else "Ассистент"
            content = (m.get("content") or "").strip().replace("\n", " ")
            if content:
                lines.append(f"{role}: {content[:400]}")
        return "\n".join(lines)

    def _retrieve(
        self,
        query: str,
        on_status: Callable[[str], None] | None = None,
        history: list[dict] | None = None,
    ) -> tuple[list[RetrievedChunk], list[str]]:
        from time import perf_counter

        if on_status:
            on_status("search")

        # === Планировщик: NL → структурный план. Заменяет регэксп-роутинг. ===
        # История нужна, чтобы разрешать ссылки «её/эту статью» из прошлых реплик.
        plan = plan_query(query, history_context=self._history_context(history))

        is_article = plan.unit == "article"

        # --- exact: «статья 81», «раздел 3», «пункт 5» ---
        if plan.mode == "exact_article" and plan.article_nos:
            t = perf_counter()
            doc_id = self._resolve_doc_hint(plan.doc_hint)
            if is_article:
                chunks = self._exact_article_by_meta(plan.article_nos, document_id=doc_id)
                if not chunks:  # старые данные без article_no — текстовый fallback
                    chunks = self._exact_article_retrieve(
                        [self._fmt_article_no(n) for n in plan.article_nos]
                    )
            else:
                chunks = self._exact_units_by_meta(plan.unit, plan.article_nos, document_id=doc_id)
            logger.info(
                "[RAG] plan=exact unit={} nos={} returned={} in {:.2f}s",
                plan.unit, plan.article_nos, len(chunks), perf_counter() - t,
            )
            if chunks:
                if is_article:
                    chunks = self._expand_with_linked_articles(chunks, max_extra=2)
                return chunks, [plan.search_text or query]

        # --- extreme: «первая/последняя статья/раздел/глава/пункт» ---
        if plan.mode == "extreme" and plan.extreme:
            t = perf_counter()
            if is_article:
                chunks = self._extreme_article_by_meta(
                    plan.extreme, plan.search_text or query, doc_hint=plan.doc_hint
                )
                if not chunks:  # fallback на старый скан заголовков
                    no = self._find_extreme_article_number(plan.extreme)
                    if no:
                        chunks = self._exact_article_retrieve([no])
            else:
                chunks = self._extreme_unit_by_meta(
                    plan.unit, plan.extreme, plan.search_text or query, doc_hint=plan.doc_hint
                )
            logger.info(
                "[RAG] plan=extreme unit={} kind={} returned={} in {:.2f}s",
                plan.unit, plan.extreme, len(chunks), perf_counter() - t,
            )
            if chunks:
                return chunks, [plan.search_text or query]

        # --- range: «первые/последние N статей/разделов/пунктов» ---
        if plan.mode == "range" and plan.range_n:
            t = perf_counter()
            if is_article:
                chunks = self._range_articles_by_meta(
                    plan.range_n, plan.range_order, plan.search_text or query,
                    doc_hint=plan.doc_hint,
                )
                if not chunks:  # fallback на старый каталожный путь
                    chunks = self._list_query_retrieve(
                        plan.search_text or query, plan.range_n, plan.range_order
                    )
            else:
                chunks = self._range_units_by_meta(
                    plan.unit, plan.range_n, plan.range_order,
                    plan.search_text or query, doc_hint=plan.doc_hint,
                )
            logger.info(
                "[RAG] plan=range unit={} N={} order={} returned={} in {:.2f}s",
                plan.unit, plan.range_n, plan.range_order, len(chunks), perf_counter() - t,
            )
            if chunks:
                return chunks, [plan.search_text or query]

        # --- count: «сколько статей/разделов/глав» ---
        if plan.mode == "count":
            t = perf_counter()
            if is_article:
                chunks = self._count_articles(plan.search_text or query, doc_hint=plan.doc_hint)
            else:
                chunks = self._count_units(plan.unit, plan.search_text or query, doc_hint=plan.doc_hint)
            logger.info(
                "[RAG] plan=count unit={} returned={} in {:.2f}s",
                plan.unit, len(chunks), perf_counter() - t,
            )
            if chunks:
                return chunks, [plan.search_text or query]

        # --- Safety net: планировщик мог отдать semantic, но в запросе явно «статья N» ---
        if plan.mode == "semantic":
            explicit = _extract_article_numbers(query)
            if explicit:
                chunks = self._exact_article_retrieve(explicit)
                if chunks:
                    logger.info("[RAG] safety-net exact-article: {}", explicit)
                    chunks = self._expand_with_linked_articles(chunks, max_extra=2)
                    return chunks, [query]

        # === Семантический путь (plan.mode == "semantic" | "compare") ===
        # Шаг 0: переписываем запрос если есть отрицания.
        rewritten = self._maybe_rewrite_query(query)
        # Темы для приоритизации (тегов) — необязательно, дёшево если LLM не нагружена
        topics: list[str] = []
        if settings.rag_use_topic_classify:
            topics = self._classify_topics(rewritten)
            if topics:
                logger.info("[RAG] topics: {}", topics)
        subqueries = self._maybe_decompose(rewritten)
        # Декомпозиция должна ДОПОЛНЯТЬ, а не заменять оригинал: иначе для развёрнутых
        # формулировок («расскажи, что нужно знать, если уволить за прогул») поиск идёт
        # только по узким подвопросам, и главная статья (ст. 81) не попадает в пул.
        search_set = list(dict.fromkeys([rewritten, *subqueries]))

        # Параллельно: каждому запросу — свой retrieve
        all_candidates: list[RetrievedChunk] = []
        for sub in search_set:
            search_query = self._maybe_hyde(sub)
            t = perf_counter()
            candidates = self.retriever.search(search_query, topics=topics or None)
            logger.info(
                "[RAG] sub-search '{}' → {} candidates ({:.2f}s)",
                sub[:60],
                len(candidates),
                perf_counter() - t,
            )
            all_candidates.extend(candidates)

        # Дедуп по (document_id, chunk_index)
        seen: set[tuple] = set()
        uniq: list[RetrievedChunk] = []
        for c in all_candidates:
            key = (c.document_id, c.chunk_index, c.text[:80])
            if key in seen:
                continue
            seen.add(key)
            uniq.append(c)

        if not uniq:
            return [], subqueries

        if on_status:
            on_status("rerank")
        t = perf_counter()
        top = self.reranker.rerank(query, uniq)
        # Safety-net: реранкер (особенно «base») бывает уверенно неправ и ВЫБРАСЫВАЕТ
        # сильный результат гибридного поиска (напр. ст. 183 на «заболел» — RRF #1, а
        # реранкер топит). Гарантируем, что топ-N RRF дойдут до контекста: реранкер
        # переупорядочивает, но не теряет.
        seen_keys = {(c.document_id, c.chunk_index) for c in top}
        for c in uniq[: settings.rerank_rrf_keep]:
            key = (c.document_id, c.chunk_index)
            if key not in seen_keys:
                top.append(c)
                seen_keys.add(key)
        # Разворачиваем ТОП-статьи целиком: перечни/основания (напр. прогул — п.6а
        # ст. 81) бывают глубоко в длинной статье, а реранкер поднимает лишь один
        # её фрагмент. Подтягиваем все чанки самых релевантных статей, чтобы LLM
        # видел статью полностью, а не обрывок.
        top = self._augment_with_articles(top)
        logger.info("[RAG] rerank: {:.2f}s, top={}/{}", perf_counter() - t, len(top), len(uniq))
        return top, subqueries

    def _augment_with_articles(
        self, chunks: list[RetrievedChunk], max_full: int = 2
    ) -> list[RetrievedChunk]:
        """Для топ-`max_full` статей (по порядку реранка) подтягивает ВСЕ их чанки —
        полная статья в контексте. Полные статьи идут первыми, в порядке chunk_index."""
        from services.rag.chunker import parse_article_no

        store = get_store()
        existing = {(c.document_id, c.chunk_index) for c in chunks}
        seen_arts: set = set()
        extra: list[RetrievedChunk] = []
        for c in chunks:
            no = parse_article_no(c.text)
            if no is None or (no, c.document_id) in seen_arts:
                continue
            if len(seen_arts) >= max_full:
                break
            seen_arts.add((no, c.document_id))
            try:
                full = store.fetch_chunks_by_article_no(no, document_id=c.document_id, limit=12)
            except Exception:
                continue
            for h in full:
                key = (h.document_id, (h.payload or {}).get("chunk_index"))
                if key not in existing:
                    extra.append(self._hit_to_chunk(h, score=c.score))
                    existing.add(key)
        return extra + chunks

    # ---------------------------------------------------------------
    # Локальный RAG по прикреплённому документу (#14)
    # ---------------------------------------------------------------

    # Вопрос сформулирован «про этот документ/файл» — тогда нормативка из базы знаний
    # не должна конкурировать с содержимым вложения (баг: «начал отвечать по базе»).
    _ABOUT_ATTACHMENT_RE = re.compile(
        r"\b(документ\w*|файл\w*|вложени\w*|тексте?|прикреплённ\w*|прикреплен\w*|"
        r"здесь|тут)\b",
        re.IGNORECASE,
    )

    def _is_overview_query(self, query: str) -> bool:
        q = (query or "").strip()
        return len(q) < 20 or bool(self._OVERVIEW_RE.search(q))

    def _is_about_attachment(self, query: str) -> bool:
        """Запрос явно про сам приложенный документ (обзор/«в этом файле…»).
        НЕ срабатывает, если в запросе явный номер статьи — это адресный KB-запрос,
        нормативку в таком случае оставляем."""
        q = query or ""
        if _extract_article_numbers(q):
            return False
        return bool(self._OVERVIEW_RE.search(q)) or bool(self._ABOUT_ATTACHMENT_RE.search(q))

    @staticmethod
    def _spread_sample(chunks: list[str], k: int) -> list[str]:
        """Равномерная выборка по всему документу (для обзорных запросов),
        всегда включает начало."""
        if len(chunks) <= k:
            return chunks
        idxs = sorted({round(i * (len(chunks) - 1) / (k - 1)) for i in range(k)})
        return [chunks[i] for i in idxs][:k]

    def _rank_attachment_chunks(self, query: str, chunks: list[str], k: int) -> list[str]:
        """Косинусная близость чанков вложения к запросу — берём top-k (в исходном порядке)."""
        if len(chunks) <= k:
            return chunks
        try:
            import numpy as np

            qv = np.asarray(self.retriever.encoder.encode_one(query, is_query=True), dtype=float)
            mat = np.asarray(self.retriever.encoder.encode(chunks, is_query=False), dtype=float)
            denom = (np.linalg.norm(mat, axis=1) * np.linalg.norm(qv)) + 1e-9
            sims = (mat @ qv) / denom
            top = sorted(int(i) for i in np.argsort(-sims)[:k])
            return [chunks[i] for i in top]
        except Exception as e:
            logger.warning("attachment ranking failed, fallback to head: {}", e)
            return chunks[:k]

    def _select_attachment_context(
        self, query: str, attached_documents: list[dict]
    ) -> tuple[list[dict], list[dict]]:
        """Готовит контекст и источники по вложениям. Вместо «первые N символов»
        дробит документ на чанки и выбирает релевантные запросу (или равномерную
        выборку для обзорных запросов) — не раздувая контекстное окно."""
        from services.rag.chunker import split_text

        ctx: list[dict] = []
        srcs: list[dict] = []
        overview = self._is_overview_query(query)
        for doc in attached_documents:
            text = (doc.get("content") or "").strip()
            if not text:
                continue
            fname = doc.get("filename", "файл")
            att_id = doc.get("id")

            if len(text) <= self._ATTACHMENT_MAX_CHARS:
                picked = [text]
            else:
                chunks = [c.text for c in split_text(text)]
                if not chunks:
                    picked = [text[: self._ATTACHMENT_MAX_CHARS]]
                elif overview:
                    picked = self._spread_sample(chunks, self._ATTACHMENT_MAX_CHUNKS)
                else:
                    picked = self._rank_attachment_chunks(query, chunks, self._ATTACHMENT_MAX_CHUNKS)
                # Страховка по суммарному размеру
                joined = 0
                limited: list[str] = []
                for frag in picked:
                    if joined + len(frag) > self._ATTACHMENT_MAX_CHARS and limited:
                        break
                    limited.append(frag)
                    joined += len(frag)
                picked = limited or picked[:1]

            multi = len(picked) > 1
            for j, frag in enumerate(picked):
                title = f"Прикреплённый документ «{fname}»" + (f" (фрагмент {j + 1})" if multi else "")
                ctx.append({"title": title, "text": frag, "source_uri": "session"})
                srcs.append({
                    "title": fname,
                    "uri": "",
                    "type": "attachment",
                    "document_id": None,
                    "attachment_id": att_id,
                    "article": None,
                    "score": 1.0,
                    "priority": 2,
                })
        return ctx, srcs

    # ---------------------------------------------------------------
    # Main answer stream
    # ---------------------------------------------------------------

    def _recent_news_context(self, limit: int = 6) -> tuple[list[dict], list[dict]]:
        """Последние опубликованные новости /news → чанки контекста + источники
        (кликабельная ссылка на статью). Используется, когда спрашивают про новости."""
        from data.db_session import create_session
        from data.news import NewsPost

        db = create_session()
        try:
            posts = (
                db.query(NewsPost)
                .filter(NewsPost.is_published.is_(True))
                .order_by(NewsPost.is_pinned.desc(), NewsPost.created_at.desc())
                .limit(limit)
                .all()
            )
            ctx: list[dict] = []
            srcs: list[dict] = []
            for p in posts:
                text = re.sub(r"<[^>]+>", " ", p.body_html or "")
                text = re.sub(r"\s+", " ", text).strip()
                date = p.created_at.strftime("%d.%m.%Y") if p.created_at else ""
                title = p.title or "Новость"
                body = f"Дата публикации: {date}.\n{text}".strip()
                ctx.append({"title": f"Новость HR: {title}", "text": body,
                            "source_uri": f"/news/{p.id}"})
                srcs.append({"title": f"Новость HR: {title}", "source_type": "news",
                             "url": f"/news/{p.id}"})
            return ctx, srcs
        finally:
            db.close()

    def answer_stream(
        self,
        query: str,
        history: list[dict] | None = None,
        use_rag: bool = True,
        attached_documents: list[dict] | None = None,
        dialogue_summary: str | None = None,
        on_status: Callable[[str], None] | None = None,
        extra_context: str | None = None,
        allow_no_context_answer: bool = False,
        intent_hint: str | None = None,
    ) -> RAGResult:
        sources: list[dict] = []
        context_chunks: list[dict] = []
        subqueries: list[str] = []
        has_attachment = bool(attached_documents)

        # Опечатки ломают регэксп-гейты и BM25 («пиривет» → RAG-отказ вместо
        # приветствия). routed — исправленная версия для роутинга и ПОИСКА;
        # оригинал query остаётся в промпте модели (она сама устойчива к опечаткам).
        routed = correct_typos(query)

        # Вопрос про новости HR → отвечаем из ленты /news (последние посты в контекст).
        news_query = use_rag and not has_attachment and bool(_NEWS_RE.search(routed))
        # Запрос на выдачу бланка/образца → прямая отдача файла (см. короткое замыкание ниже).
        blank_request = use_rag and not has_attachment and bool(_BLANK_RE.search(routed))

        # Контекстное намерение: если вызывающий код его не определил — считаем
        # сами (эмбеддинг-классификатор + LLM для пограничных случаев). None →
        # решают прежние регэксп-гейты ниже.
        if intent_hint is None and use_rag and not has_attachment:
            from services.rag.intent_classifier import resolve_intent

            intent_hint = resolve_intent(routed, history)

        # Болтовня («спасибо», «привет», «ладно, не то») и тривиальные/мусорные запросы
        # («1+1», «вавыы») → обычный разговорный ответ без поиска и без RAG-отказа (#13).
        # НО короткие уточняющие продолжения в диалоге («а подробнее?», «процитируй её»)
        # НЕ гасим — это доп-вопрос по той же теме; пусть планировщик разрешит ссылку по
        # истории и вернёт источники (иначе ответ ссылается на статьи без блока «Источники»).
        # === Болтовня/мусор решаем ДО FAQ ===
        # Раньше «нечёткое» совпадение с FAQ (порог 0.70) перебивало этот гейт и
        # тянуло «как дела?» в поиск. Теперь сначала определяем болтовню — и только
        # если реально ищем, спрашиваем FAQ-матчер.
        casual = False
        if use_rag and not has_attachment and not news_query and not _is_followup(routed, history):
            # ЖЁСТКИЙ ПРЕДОХРАНИТЕЛЬ смешанного сообщения («Привет! … текст 28 статьи»):
            # явный информационный сигнал → это НЕ болтовня, что бы ни решил классификатор.
            has_info_signal = bool(_INFO_RE.search(routed)) or bool(_extract_article_numbers(routed))
            # _SOCIAL_RE («как дела», «кто ты», «что умеешь») — ОДНОЗНАЧНАЯ болтовня о
            # самом ассистенте; её нельзя перебивать широким инфо-триггером «как »
            # (иначе «как дела?» уходит в бессмысленный поиск по всей базе).
            is_small = bool(_SOCIAL_RE.search(routed)) or (
                (intent_hint == "smalltalk" or _is_smalltalk(routed))
                and not has_info_signal
            )
            if is_small or _looks_nonknowledge(routed):
                logger.info("[RAG] нет смысла искать (болтовня/тривиальный запрос) — обычный ответ")
                use_rag = False
                casual = is_small
            elif intent_hint == "meta_chat" and history:
                # Вопрос о самой переписке → ответ по истории, без поиска по БЗ
                # (retrieval по такой фразе тянет случайные документы).
                logger.info("[RAG] мета-вопрос о диалоге — отвечаем по истории, без поиска")
                use_rag = False

        # === FAQ отдела кадров (А2) — только если реально ищем ===
        # Курируемые ответы из файлов «чат-бот …»: совпадение по вариантам
        # формулировок ОБОГАЩАЕТ контекст LLM (первый чанк + контакт в футер).
        # Чёткий FAQ-ответ без LLM даётся только кнопками быстрого набора на
        # /chat (faq_id); свободный текст всегда идёт обычным потоком.
        faq_hit = None
        if use_rag and not has_attachment:
            from services.rag import faq as faq_mod

            try:
                faq_hit = faq_mod.get_matcher().match(routed, history)
            except Exception as e:
                logger.warning("[FAQ] матчинг не удался: {}", e)
                faq_hit = None

        # Совпавший FAQ-ответ идёт ПЕРВЫМ чанком контекста LLM; контакт
        # подразделения — в футер ответа (А3).
        faq_ctx: list[dict] = []
        faq_sources: list[dict] = []
        faq_contact: str | None = None
        related_files: list[dict] = []
        if faq_hit is not None:
            faq_contact = faq_hit.contact
            if faq_hit.rewritten_query:
                routed = faq_hit.rewritten_query
            text = faq_hit.answer
            if faq_hit.doc_refs:
                text += "\n\nСвязанные документы: " + "; ".join(faq_hit.doc_refs)
                # Сопоставляем названия документов с реальными файлами → карточки «Скачать».
                from services.rag.blank_forms import resolve_doc_refs
                related_files = resolve_doc_refs(faq_hit.doc_refs)

        # === Короткое замыкание «выдай бланк» ===
        # Пользователь просит бланк/образец, а нужные файлы уже найдены — отдаём их
        # напрямую коротким ответом, без RAG-поиска и LLM (иначе бот уходит в
        # рассуждения по нормативке, как в жалобе). Сужаем до запрошенного бланка.
        if blank_request and related_files:
            from services.rag.blank_forms import narrow_by_query

            narrowed = narrow_by_query(query, related_files)
            if len(narrowed) == 1:
                f = narrowed[0]
                noun = "бланк" if f["kind"] == "template" else "документ"
                canned = f"Вот {noun} «{f['title']}» — откройте или скачайте ниже."
                if f["kind"] == "template":
                    canned += " Заполнять его не нужно, шаблон готов к использованию."
            else:
                canned = ("Подходящие бланки — откройте или скачайте ниже. "
                          "Заполнять их не нужно, шаблоны готовы к использованию.")
            if on_status:
                on_status("generate")
            logger.info("[BLANKS] прямая выдача бланка(ов): {}", len(narrowed))

            def _blank_stream():
                yield canned

            return RAGResult(
                answer_stream=_blank_stream(), sources=[], used_subqueries=[],
                contact=faq_contact, related_files=narrowed,
            )
            if text.strip():
                title = f"FAQ отдела кадров: {faq_hit.block}"
                faq_ctx = [{"title": title, "text": text, "source_uri": "faq"}]
                faq_sources = [{"title": title, "source_type": "faq"}]

        # === Новости HR (вопрос «какие новости / что нового») ===
        news_ctx: list[dict] = []
        news_sources: list[dict] = []
        if news_query:
            try:
                news_ctx, news_sources = self._recent_news_context()
            except Exception as e:
                logger.warning("[NEWS] не удалось собрать новости для контекста: {}", e)
            if news_ctx:
                logger.info("[NEWS] в контекст добавлено новостей: {}", len(news_ctx))

        # === KB-выдержки ===
        # Для чистого запроса про новости KB-поиск пропускаем — иначе к ответу
        # подмешается нерелевантная нормативка.
        kb_ctx: list[dict] = []
        kb_sources: list[dict] = []
        if use_rag and not news_ctx:
            try:
                top_chunks, subqueries = self._retrieve(
                    routed, on_status=on_status, history=history
                )
            except Exception as e:
                logger.warning("Retrieval failed, fallback to plain chat: {}", e)
                top_chunks = []
            # При наличии вложения KB — лишь ПОДКРЕПЛЕНИЕ: ограничиваем, чтобы не
            # «утопить» содержание прикреплённого документа нормативкой (#6). Если вопрос
            # явно про сам документ («о чём этот файл», «что в документе про…») — KB вообще
            # не подмешиваем, иначе модель иногда уходит отвечать по базе, а не по вложению.
            if has_attachment and top_chunks:
                kb_keep = 0 if self._is_about_attachment(routed) else self._KB_SUPPORT_WITH_ATTACHMENT
                top_chunks = top_chunks[:kb_keep]
            if top_chunks:
                kb_sources = [c.to_source() for c in top_chunks]
                kb_ctx = [
                    {"title": c.title, "text": c.text, "source_uri": c.source_uri}
                    for c in top_chunks
                ]

        # === Прикреплённый документ (локальный RAG, #14) ===
        att_ctx: list[dict] = []
        att_sources: list[dict] = []
        if has_attachment:
            att_ctx, att_sources = self._select_attachment_context(routed, attached_documents)

        # Вложение идёт ПЕРВЫМ (основной материал), затем новости, курируемый FAQ,
        # KB — следом (подкрепление). sources строго в том же порядке, что и
        # context_chunks → [k] ↔ sources[k-1].
        context_chunks = att_ctx + news_ctx + faq_ctx + kb_ctx
        sources = att_sources + news_sources + faq_sources + kb_sources

        # === SHORT-CIRCUIT: «выдержек нет» ===
        # Если пользователь явно запросил RAG, но retrieval не вернул НИ ОДНОГО
        # релевантного чанка, и в сессии нет вложений — НЕ зовём LLM. Иначе модель
        # сочинит ответ «по памяти» (галлюцинации про несуществующие статьи).
        # Возвращаем фиксированный отказ через генератор-заглушку.
        if (
            use_rag
            and not context_chunks
            and not attached_documents
            and not allow_no_context_answer
            and len(query.strip()) >= 12
        ):
            if on_status:
                on_status("generate")

            # Отличаем «база знаний недоступна» (сервер поиска не отвечает) от
            # «нет релевантных документов» — иначе пользователь думает, что тема
            # не загружена, хотя на деле упал Qdrant.
            backend_down = not get_store().is_alive()
            if backend_down:
                logger.warning("[RAG] short-circuit: vector store НЕДОСТУПЕН")
                canned = (
                    "⚠️ **База знаний временно недоступна** — нет связи с сервером поиска (Qdrant).\n\n"
                    "Ответить по документам сейчас не получится. Обратитесь к администратору, "
                    "чтобы проверить, запущен ли сервис Qdrant (по умолчанию `localhost:6333`)."
                )
            else:
                logger.info("[RAG] short-circuit: 0 chunks, returning canned no-data answer")
                canned = (
                    "В предоставленных выдержках информации по вашему вопросу нет.\n\n"
                    "Возможные причины:\n"
                    "- эта тема не покрыта документами, загруженными в базу знаний;\n"
                    "- формулировка запроса не позволила найти нужный фрагмент.\n\n"
                    "**Что можно сделать:**\n"
                    "- Уточнить запрос — например, указать номер статьи, название документа или конкретный термин.\n"
                    "- Проверить актуальную редакцию официального документа напрямую (например, на «КонсультантПлюс» или «Гарант»)."
                )

            def _canned_stream():
                # Имитируем «поток» из одного чанка — клиент уже умеет с этим работать.
                yield canned

            return RAGResult(
                answer_stream=_canned_stream(),
                sources=[],
                used_subqueries=subqueries,
            )

        if on_status:
            on_status("generate")

        # Системный промпт. При вложении — отдельный промпт: отвечать по содержанию
        # прикреплённого документа, KB лишь как справка (#6, #10).
        if has_attachment and att_ctx:
            system = SYSTEM_PROMPT_ATTACHMENT
        elif casual:
            system = SYSTEM_PROMPT_SMALLTALK   # живой тон вместо канцелярита
        elif not context_chunks:
            system = SYSTEM_PROMPT_CHAT
        elif _is_compare_query(routed):
            system = SYSTEM_PROMPT_COMPARE
        else:
            system = SYSTEM_PROMPT_RAG
        if dialogue_summary:
            system = (
                f"{system}\n\n"
                f"Сводка предыдущей части диалога:\n{dialogue_summary.strip()}"
            )
        # Контекст о собеседниках/пользователе (ФИО, должность, участники чата) —
        # чтобы модель знала, с кем общается, и могла отвечать «о чём диалог».
        if extra_context:
            system = f"{system}\n\n{extra_context.strip()}"

        if context_chunks:
            user_msg = build_rag_prompt(query, context_chunks)
        else:
            user_msg = query

        # Динамическая температура по типу запроса: факты по выдержкам — минимальная
        # (детерминизм, без случайных отказов); неформальный разговор — высокая (живой
        # разнообразный тон); обычный чат без контекста — средняя.
        if context_chunks:
            temp = settings.llm_answer_temperature
        elif casual:
            temp = settings.llm_smalltalk_temperature
        else:
            temp = settings.llm_temperature
        stream = self.llm.chat_stream(
            system=system, user=user_msg, history=history, temperature=temp
        )
        return RAGResult(
            answer_stream=stream,
            sources=sources,
            used_subqueries=subqueries,
            context_texts=[c.get("text", "") for c in context_chunks],
            contact=faq_contact,
            related_files=related_files,
        )


_pipeline: RAGPipeline | None = None


def get_pipeline() -> RAGPipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = RAGPipeline()
    return _pipeline
