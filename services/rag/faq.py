"""FAQ отдела кадров (А2/А3): импорт таблиц «чат-бот …» и матчинг запросов.

Таблицы имеют 7 колонок: №, Блок вопросов, Варианты запросов, Уточняющий вопрос,
Текст комментария (ответ), Ссылки на документы, Контактное лицо. Строки одного
блока с общими вариантами (объединённые ячейки) образуют группу: у группы из
нескольких записей бот сначала задаёт уточняющий вопрос, метка под-ветки
(option_label) выбирает конкретный ответ.

Матчинг двухступенчатый и полностью локальный (эмбеддинги, без LLM):
  1) запрос → лучшая группа по вариантам формулировок;
  2) если группа ветвится — сразу под-ветка (если запрос её уже называет)
     либо уточняющий вопрос; ответ пользователя на него распознаётся по
     тексту последнего сообщения ассистента (см. match()).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

from loguru import logger

# Порог «запрос совпал с FAQ-блоком»: варианты — короткие фразы, поэтому
# требуем заметно большей близости, чем у intent-прототипов (0.50). Калибровка:
# парафразы реальных вариантов дают 0.75+, тематически чужие вопросы той же
# формы («что такое …») — до 0.65.
_GROUP_HIT = 0.70
# Порог выбора под-ветки по метке (метки ещё короче — чуть мягче + substring)
_OPTION_HIT = 0.55

_WS_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"[а-яёa-z]+", re.IGNORECASE)


def _norm(s: str) -> str:
    return _WS_RE.sub(" ", (s or "").strip())


def _lemmas(text: str) -> frozenset[str]:
    """Леммы содержательных слов (≥4 букв) — тот же нормализатор, что у BM25.
    Если ВСЕ леммы варианта есть в запросе — концепт назван явно, буст матчу
    («поехать в командировку» ⊇ «командировка», хотя эмбеддинги дают <0.7)."""
    from services.rag.retriever import _norm_word

    return frozenset(
        _norm_word(w.lower()) for w in _WORD_RE.findall(text or "") if len(w) >= 4
    )


# Буст при полном вхождении лемм варианта в запрос (см. _lemmas)
_LEMMA_BOOST = 0.88


def _lines(cell: str) -> list[str]:
    return [_norm(x) for x in (cell or "").splitlines() if _norm(x) and _norm(x) != "-"]


# ---------------------------------------------------------------------------
# Импорт docx-таблиц
# ---------------------------------------------------------------------------


def _rows_from_file(path: Path) -> list[list[str]]:
    """Строки всех таблиц файла (7 ячеек, без заголовка). .doc конвертируется."""
    from docx import Document

    p = Path(path)
    if p.suffix.lower() == ".doc":
        from services.parsers.office_convert import convert_to_modern

        p = convert_to_modern(p)
    doc = Document(str(p))
    rows: list[list[str]] = []
    for table in doc.tables:
        for r in table.rows:
            cells = [c.text for c in r.cells]
            cells += [""] * (7 - len(cells))
            if "блок вопросов" in _norm(cells[1]).lower():
                continue  # заголовок
            if not any(_norm(c) for c in cells):
                continue
            rows.append(cells[:7])
    return rows


def _group_rows(rows: list[list[str]]) -> list[list[list[str]]]:
    """Группирует строки: одинаковые непустые варианты (объединённая ячейка)
    или пустые варианты при том же блоке — продолжение группы."""
    groups: list[list[list[str]]] = []
    for cells in rows:
        block, variants = _norm(cells[1]), _lines(cells[2])
        if groups:
            prev = groups[-1][-1]
            prev_block, prev_vars = _norm(prev[1]), _lines(prev[2])
            same_vars = variants and variants == prev_vars
            continuation = not variants and (not block or block == prev_block)
            if same_vars or continuation:
                groups[-1].append(cells)
                continue
        groups.append([cells])
    return groups


def _looks_like_question(s: str) -> bool:
    low = s.lower()
    return "?" in s or low.startswith(("какой", "какая", "какие", "что", "уточните"))


def import_faq_files(paths: list[Path], db) -> dict:
    """Парсит файлы «чат-бот …» и перезаписывает faq_entries (полный реимпорт)."""
    from data.faq_entries import FAQEntry

    total_groups = total_entries = 0
    db.query(FAQEntry).delete()

    for path in paths:
        path = Path(path)
        try:
            groups = _group_rows(_rows_from_file(path))
        except Exception as e:
            logger.warning("[FAQ] не удалось разобрать {}: {}", path.name, e)
            continue

        for gi, g in enumerate(groups):
            block = next((_norm(r[1]) for r in g if _norm(r[1])), "")
            variants = next((_lines(r[2]) for r in g if _lines(r[2])), [])
            contact = next((_norm(r[6]).rstrip(".") for r in g if _norm(r[6])), None)
            key_src = f"{path.name}:{gi}:{block}"
            group_key = hashlib.md5(key_src.encode("utf-8")).hexdigest()[:16]

            if len(g) == 1:
                clar = _lines(g[0][3])
                # Одиночная строка без вариантов, но со списком ключевых слов в
                # колонке уточнения («Социальная программа»: Льготы/Ипотека/ДМС…) —
                # это варианты запросов, попавшие не в ту колонку.
                if not variants and clar and not _looks_like_question(clar[0]):
                    variants = clar
                if block and block not in variants:
                    variants = [block] + variants
                db.add(FAQEntry(
                    group_key=group_key, position=0, source_file=path.name,
                    block=block, variants=variants, clarify_question=None,
                    option_label=None, answer="\n".join(_lines(g[0][4])),
                    doc_refs=_lines(g[0][5]) or None, contact=contact,
                ))
                total_entries += 1
            else:
                # Ветвящаяся группа. Строка-заголовок — та, чья колонка уточнения
                # похожа на вопрос (или просто первая): её ответ — общее вступление.
                if block and block not in variants:
                    variants = [block] + variants
                head_idx = next(
                    (i for i, r in enumerate(g)
                     if _lines(r[3]) and _looks_like_question(_lines(r[3])[0])),
                    None,
                )
                clarify_q = None
                intro = ""
                subs = list(range(len(g)))
                if head_idx is not None:
                    clarify_q = _lines(g[head_idx][3])[0]
                    intro = "\n".join(_lines(g[head_idx][4]))
                    subs.remove(head_idx)
                db.add(FAQEntry(
                    group_key=group_key, position=0, source_file=path.name,
                    block=block, variants=variants, clarify_question=clarify_q,
                    option_label=None, answer=intro,
                    doc_refs=None, contact=contact,
                ))
                total_entries += 1
                for pos, i in enumerate(subs, start=1):
                    label_lines = _lines(g[i][3])
                    label = " / ".join(label_lines) if label_lines else f"Вариант {pos}"
                    db.add(FAQEntry(
                        group_key=group_key, position=pos, source_file=path.name,
                        block=block, variants=None, clarify_question=None,
                        option_label=label, answer="\n".join(_lines(g[i][4])),
                        doc_refs=_lines(g[i][5]) or None,
                        contact=_norm(g[i][6]).rstrip(".") or contact,
                    ))
                    total_entries += 1
            total_groups += 1

    db.commit()
    get_matcher().invalidate()
    logger.info("[FAQ] импорт: {} групп, {} записей из {} файлов",
                total_groups, total_entries, len(paths))
    return {"groups": total_groups, "entries": total_entries}


# ---------------------------------------------------------------------------
# Матчинг
# ---------------------------------------------------------------------------


@dataclass
class Hit:
    """Запрос совпал с конкретной FAQ-записью — её ответ идёт в контекст LLM."""
    entry_id: int
    block: str
    answer: str
    doc_refs: list[str] = field(default_factory=list)
    contact: str | None = None
    score: float = 0.0
    # Переписанный запрос для KB-поиска (вопрос + выбранная под-ветка)
    rewritten_query: str | None = None


def _cos(a, b) -> float:
    s = na = nb = 0.0
    for x, y in zip(a, b):
        s += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return s / ((na ** 0.5) * (nb ** 0.5))


def _option_first(label: str) -> str:
    return _norm((label or "").split(" / ")[0])


class FAQMatcher:
    def __init__(self) -> None:
        self._lock = Lock()
        self._loaded = False
        # group_key -> {"phrases": [(text, vec)], "head": dict, "subs": [dict]}
        self._groups: dict[str, dict] = {}

    def invalidate(self) -> None:
        with self._lock:
            self._loaded = False

    def _entry_dict(self, e) -> dict:
        return {
            "id": e.id, "block": e.block, "answer": e.answer or "",
            "doc_refs": list(e.doc_refs or []), "contact": e.contact,
            "clarify_question": e.clarify_question,
            "option_label": e.option_label, "position": e.position,
        }

    def _ensure(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            from data.db_session import create_session
            from data.faq_entries import FAQEntry
            from services.embeddings import get_encoder

            db = create_session()
            try:
                rows = (
                    db.query(FAQEntry)
                    .filter(FAQEntry.is_active.is_(True))
                    .order_by(FAQEntry.group_key, FAQEntry.position)
                    .all()
                )
                by_group: dict[str, list] = {}
                for e in rows:
                    by_group.setdefault(e.group_key, []).append(e)

                enc = get_encoder()
                groups: dict[str, dict] = {}
                # Собираем все фразы одним батчем — быстрее на прогреве
                plan: list[tuple[str, str, str]] = []  # (group, kind:variant|option, text)
                for gk, es in by_group.items():
                    head = next((x for x in es if x.position == 0), es[0])
                    subs = [x for x in es if x.position > 0]
                    groups[gk] = {
                        "head": self._entry_dict(head),
                        "subs": [self._entry_dict(s) for s in subs],
                        "phrases": [], "opt_vecs": [],
                    }
                    for v in (head.variants or []):
                        plan.append((gk, "variant", v))
                    for s in subs:
                        for line in (s.option_label or "").split(" / "):
                            if _norm(line):
                                plan.append((gk, f"opt:{s.id}", _norm(line)))

                # Нижний регистр перед эмбеддингом: энкодер регистро-зависим, иначе
                # «Как дела?»/«как дела?» дают разные векторы и разный вердикт FAQ.
                vecs = enc.encode([t.lower() for _, _, t in plan], is_query=True) if plan else []
                for (gk, kind, text), vec in zip(plan, vecs):
                    if kind == "variant":
                        groups[gk]["phrases"].append((text, vec, _lemmas(text)))
                    else:
                        groups[gk]["opt_vecs"].append(
                            (int(kind.split(":")[1]), text, vec, _lemmas(text))
                        )
            finally:
                db.close()

            self._groups = groups
            self._loaded = True
            logger.info("[FAQ] матчер прогрет: {} групп, {} фраз",
                        len(groups), sum(len(g["phrases"]) for g in groups.values()))

    # -- публичное API ------------------------------------------------------

    def match(self, query: str, history: list[dict] | None = None) -> Hit | None:
        self._ensure()
        if not self._groups:
            return None
        from services.embeddings import get_encoder

        q = _norm(query)
        if len(q) < 3:
            return None
        qv = get_encoder().encode_one(q.lower(), is_query=True)

        # Общий матч по вариантам формулировок
        best_gk, best_score, best_phrase = None, 0.0, ""
        ql = q.lower()
        q_lems = _lemmas(q)
        for gk, g in self._groups.items():
            for text, vec, lems in g["phrases"]:
                score = _cos(qv, vec)
                tl = text.lower()
                # Точное вхождение формулировки — сильный сигнал независимо от эмбеддинга
                if len(tl) >= 6 and (tl in ql or ql in tl):
                    score = max(score, 0.90)
                # Все содержательные леммы варианта названы в запросе
                elif lems and lems <= q_lems:
                    score = max(score, _LEMMA_BOOST)
                if score > best_score:
                    best_gk, best_score, best_phrase = gk, score, text
        if not best_gk or best_score < _GROUP_HIT:
            return None

        g = self._groups[best_gk]
        logger.info("[FAQ] группа «{}» (score={:.2f}, фраза «{}»)",
                    g["head"]["block"], best_score, best_phrase)

        if not g["subs"]:
            h = g["head"]
            return Hit(
                entry_id=h["id"], block=h["block"], answer=h["answer"],
                doc_refs=h["doc_refs"], contact=h["contact"], score=best_score,
            )

        # Ветвящаяся группа: запрос уже называет под-ветку? Тогда точный под-ответ.
        direct = self._match_option(best_gk, q, qv, history, rewritten=False)
        if direct:
            direct.score = max(direct.score, best_score)
            return direct

        # Иначе — сводный контекст из всех под-ответов (уточняющий выбор делают
        # кнопки быстрого набора на /chat; бот не перехватывает диалог вопросом,
        # LLM сама раскроет подходящие ветки в ответе).
        parts: list[str] = []
        docs: list[str] = []
        if g["head"]["answer"]:
            parts.append(g["head"]["answer"])
        for s in g["subs"]:
            label = _option_first(s["option_label"])
            if s["answer"]:
                parts.append(f"{label}: {s['answer']}")
            docs.extend(d for d in s["doc_refs"] if d not in docs)
        return Hit(
            entry_id=g["head"]["id"], block=g["head"]["block"],
            answer="\n\n".join(parts), doc_refs=docs,
            contact=g["head"]["contact"], score=best_score,
        )

    def _match_option(
        self, group_key: str, q: str, qv, history: list[dict] | None,
        rewritten: bool = True,
    ) -> Hit | None:
        g = self._groups.get(group_key)
        if not g or not g["subs"]:
            return None
        ql = q.lower()
        q_lems = _lemmas(q)
        best_id, best_score = None, 0.0
        for entry_id, text, vec, lems in g["opt_vecs"]:
            score = _cos(qv, vec)
            tl = text.lower()
            if len(tl) >= 4 and (tl in ql or ql in tl):
                score = max(score, 0.90)
            elif lems and lems <= q_lems:
                score = max(score, _LEMMA_BOOST)
            if score > best_score:
                best_id, best_score = entry_id, score
        if best_id is None or best_score < _OPTION_HIT:
            return None
        sub = next(s for s in g["subs"] if s["id"] == best_id)

        rew = None
        if rewritten:
            # Исходный вопрос (до уточнения) + выбранная ветка → нормальный
            # поисковый запрос для KB вместо односложного «увольнение».
            prev_user = None
            for m in reversed(history or []):
                if m.get("role") == "user":
                    prev_user = _norm(m.get("content") or "")
                    break
            label = _option_first(sub["option_label"])
            rew = f"{prev_user} — {label}" if prev_user else label
        answer = sub["answer"]
        if g["head"]["answer"] and rewritten:
            answer = (answer + "\n\n" + g["head"]["answer"]).strip()
        return Hit(
            entry_id=sub["id"], block=sub["block"], answer=answer,
            doc_refs=sub["doc_refs"], contact=sub["contact"] or g["head"]["contact"],
            score=best_score, rewritten_query=rew,
        )


_matcher: FAQMatcher | None = None


def get_matcher() -> FAQMatcher:
    global _matcher
    if _matcher is None:
        _matcher = FAQMatcher()
    return _matcher
