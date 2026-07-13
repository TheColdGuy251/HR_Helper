"""Резолвер «связанных документов» FAQ → реальные скачиваемые файлы (А2/А3).

FAQ-таблицы называют документы свободным текстом («Заявление об увольнении»,
«Порядок аттестации…»). Здесь сопоставляем эти названия с реальными шаблонами
(doc_templates — бланки заявлений) и документами базы знаний, чтобы бот отдавал
их кликабельными карточками «Скачать/Открыть», а не просто текстом.

Матчинг — по пересечению значимых слов (Jaccard), полностью локально, без LLM.
Порог консервативный: лучше не показать карточку, чем подсунуть чужой файл.
"""

from __future__ import annotations

import re
from threading import Lock

from utils.logger import logger

_WORD_RE = re.compile(r"[а-яёa-z0-9]+", re.IGNORECASE)
_STOP = {
    "и", "или", "для", "на", "по", "об", "от", "при", "из", "до", "к", "во",
    "the", "a", "of", "тиу", "файл", "приложен", "приложены", "шаблон", "бланк",
    "пример", "примеры", "образец", "образцы", "скачать",
}
# Порог совпадения (Jaccard значимых слов). ≥0.5 отсекает «отпуск≈отпуск» ложняки.
_HIT = 0.5


def _tokens(s: str) -> frozenset[str]:
    return frozenset(
        w.lower() for w in _WORD_RE.findall(s or "")
        if len(w) >= 3 and w.lower() not in _STOP
    )


def _score(rt: frozenset[str], ct: frozenset[str]) -> float:
    if not rt or not ct:
        return 0.0
    inter = len(rt & ct)
    if not inter:
        return 0.0
    jac = inter / len(rt | ct)
    # Все слова ссылки содержатся в названии кандидата — уверенное совпадение.
    if rt <= ct:
        jac = max(jac, 0.8)
    return jac


class _Catalog:
    def __init__(self) -> None:
        self._lock = Lock()
        self._loaded = False
        self._items: list[dict] = []

    def invalidate(self) -> None:
        with self._lock:
            self._loaded = False

    def _ensure(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            from data.db_session import create_session
            from data.doc_templates import DocTemplate
            from data.kb_documents import KBDocument

            db = create_session()
            items: list[dict] = []
            try:
                for t in db.query(DocTemplate).filter(DocTemplate.is_enabled.is_(True)).all():
                    items.append({
                        "title": t.title, "toks": _tokens(t.title), "kind": "template",
                        "url": f"/api/kb/templates/{t.id}/download",
                        "view_url": f"/kb/templates/{t.id}/view",
                    })
                for d in db.query(KBDocument).filter(KBDocument.status == "indexed").all():
                    items.append({
                        "title": d.title, "toks": _tokens(d.title), "kind": "document",
                        "url": f"/api/kb/documents/{d.id}/download",
                        "view_url": f"/kb/documents/{d.id}/view",
                    })
            finally:
                db.close()
            self._items = items
            self._loaded = True
            logger.info("[BLANKS] каталог загружен: {} шаблонов/документов", len(items))

    def resolve(self, doc_refs: list[str]) -> list[dict]:
        self._ensure()
        out: list[dict] = []
        seen: set[str] = set()
        for ref in doc_refs or []:
            rt = _tokens(ref)
            if not rt:
                continue
            best, best_score = None, 0.0
            for it in self._items:
                sc = _score(rt, it["toks"])
                # при равенстве предпочитаем шаблон-бланк
                if sc > best_score or (
                    sc == best_score and best is not None
                    and it["kind"] == "template" and best["kind"] != "template"
                ):
                    best, best_score = it, sc
            if best and best_score >= _HIT and best["url"] not in seen:
                seen.add(best["url"])
                out.append({
                    "title": (ref or "").strip() or best["title"],
                    "kind": best["kind"],
                    "url": best["url"],
                    "view_url": best["view_url"],
                })
        return out


_catalog: _Catalog | None = None


def get_catalog() -> _Catalog:
    global _catalog
    if _catalog is None:
        _catalog = _Catalog()
    return _catalog


def resolve_doc_refs(doc_refs: list[str]) -> list[dict]:
    """[{title, kind: template|document, url, view_url}] для распознанных ссылок."""
    try:
        return get_catalog().resolve(doc_refs)
    except Exception as e:
        logger.warning("[BLANKS] резолв doc_refs не удался: {}", e)
        return []


# Служебные слова запроса, не различающие конкретный бланк («дай бланк заявления …»).
_GENERIC = {
    "заявление", "заявления", "заявлений", "бланк", "бланка", "бланки", "образец",
    "образца", "образцы", "шаблон", "шаблона", "форма", "формы", "форму", "документ",
    "документа", "документы", "выдай", "дай", "дать", "нужно", "нужен", "нужна",
    "скачать", "служебная", "служебной", "записка", "записку", "получить", "хочу",
    "пришлите", "пришли", "предоставить", "предоставьте", "где", "взять",
}


def narrow_by_query(query: str, files: list[dict]) -> list[dict]:
    """Из карточек-бланков оставляет те, чьи названия содержат ОТЛИЧИТЕЛЬНЫЕ (не
    служебные) слова запроса. «дай бланк заявления о переносе отпуска» → только
    «Заявление о переносе отпуска». Нет совпадений — возвращаем все (как было)."""
    qt = {t for t in _tokens(query) if t not in _GENERIC}
    if not qt or not files:
        return files
    scored = [(len(qt & _tokens(f.get("title", ""))), f) for f in files]
    best = max((h for h, _ in scored), default=0)
    if best <= 0:
        return files
    return [f for h, f in scored if h == best]
