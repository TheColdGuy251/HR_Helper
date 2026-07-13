from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from rank_bm25 import BM25Okapi
from config import settings
from services.embeddings import get_encoder
from services.vectorstore import get_store
from utils.logger import logger


_TOKEN_RE = re.compile(r"[\wа-яёА-ЯЁ]+", re.UNICODE)

# Морфологическая нормализация для BM25 (одинаково к корпусу и к запросу).
# Слои по убыванию качества: pymorphy3 (лемматизация) → snowball (стемминг) →
# identity. Лемматизация точнее: «прогула»→«прогул», «работника»→«работник»,
# «уволен»→«уволить». Кэшируем — в юр-текстах слова часто повторяются.
def _make_normalizer():
    try:
        import pymorphy3

        morph = pymorphy3.MorphAnalyzer()

        @lru_cache(maxsize=100_000)
        def _norm(word: str) -> str:
            return morph.parse(word)[0].normal_form

        logger.info("BM25 нормализация: pymorphy3 (лемматизация)")
        return _norm
    except Exception as e:  # pragma: no cover
        logger.warning("pymorphy3 недоступен ({}), пробую snowball", e)
    try:
        import snowballstemmer

        stemmer = snowballstemmer.stemmer("russian")

        @lru_cache(maxsize=100_000)
        def _norm(word: str) -> str:
            return stemmer.stemWord(word)

        logger.info("BM25 нормализация: snowball (стемминг)")
        return _norm
    except Exception as e:  # pragma: no cover
        logger.warning("snowball недоступен ({}), BM25 без морфологии", e)
        return lambda w: w


_norm_word = _make_normalizer()


# Безопасный стоп-лист: только служебные слова (предлоги/союзы/местоимения).
# НЕ включаем отрицания («не», «без», «нет», «нельзя») — в нормативных текстах
# они несут смысл («без уважительных причин», «не допускается»).
_RU_STOP = {
    "и", "в", "во", "на", "с", "со", "к", "ко", "у", "же", "по", "за", "от",
    "о", "об", "обо", "из", "изо", "для", "при", "про", "до", "над", "под",
    "подо", "через", "между", "а", "но", "или", "либо", "что", "как", "так",
    "это", "этот", "эта", "эти", "этого", "этой", "этом", "тот", "та", "те",
    "он", "она", "оно", "они", "его", "ее", "её", "их", "им", "ему", "ей",
    "я", "ты", "мы", "вы", "мне", "меня", "тебя", "нас", "вас", "них", "ним",
    "ней", "быть", "был", "была", "было", "были", "есть", "бы", "ли",
}


def _tokenize(text: str) -> list[str]:
    out: list[str] = []
    for t in _TOKEN_RE.findall(text or ""):
        t = t.lower()
        if t in _RU_STOP:
            continue
        # одиночные буквы — мусор; одиночные цифры (номер статьи «5») сохраняем
        if len(t) < 2 and not t.isdigit():
            continue
        out.append(_norm_word(t))
    return out


@dataclass
class RetrievedChunk:
    text: str
    score: float
    document_id: int | None
    chunk_index: int | None
    title: str
    source_uri: str
    source_type: str
    priority: int = 2  # 1=низкий, 2=средний (по умолчанию), 3=высокий

    def to_source(self) -> dict[str, Any]:
        # Метка статьи из текста чанка (для блока «Источники» и перенумерации ссылок).
        from services.rag.chunker import parse_article_no

        no = parse_article_no(self.text)
        article = None
        if no is not None:
            article = f"Статья {int(no) if float(no).is_integer() else no}"
        return {
            "title": self.title,
            "uri": self.source_uri,
            "type": self.source_type,
            "document_id": self.document_id,
            "article": article,
            "score": round(self.score, 4),
            "priority": self.priority,
        }


class HybridRetriever:
    """Гибридный поиск: dense (Qdrant) + sparse (BM25 в памяти) c RRF-объединением."""

    def __init__(self):
        self.encoder = get_encoder()
        self.store = get_store()
        self._bm25_corpus: list[str] = []
        self._bm25_meta: list[dict[str, Any]] = []
        self._bm25: BM25Okapi | None = None

    def rebuild_bm25(self, chunks: list[dict[str, Any]]) -> None:
        """Полное обновление BM25-индекса по чанкам (text + payload)."""
        self._bm25_corpus = [c["text"] for c in chunks]
        self._bm25_meta = chunks
        tokenized = [_tokenize(t) for t in self._bm25_corpus]
        self._bm25 = BM25Okapi(tokenized) if tokenized else None
        logger.info("BM25 индекс перестроен: {} чанков", len(self._bm25_corpus))

    def _bm25_search(self, query: str, top_k: int) -> list[tuple[int, float]]:
        if self._bm25 is None or not self._bm25_corpus:
            return []
        scores = self._bm25.get_scores(_tokenize(query))
        ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
        return [(idx, float(s)) for idx, s in ranked[:top_k] if s > 0]

    @staticmethod
    def _rrf(rank: int, k: int = 60) -> float:
        return 1.0 / (k + rank + 1)

    def search(
        self,
        query: str,
        top_k: int | None = None,
        topics: list[str] | None = None,
    ) -> list[RetrievedChunk]:
        top_k = top_k or settings.retrieval_top_k

        # 1) Dense через Qdrant
        try:
            qvec = self.encoder.encode_one(query, is_query=True)
            dense_hits = self.store.search(qvec, top_k=top_k, tags_any=topics)
        except Exception as e:
            logger.warning("Dense поиск не удался: {}", e)
            dense_hits = []

        # 2) Sparse через BM25
        sparse_hits = self._bm25_search(query, top_k=top_k)

        # 3) RRF слияние: ключ — сам чанк, а не канал поиска. Чанк, найденный
        # И dense, И BM25, суммирует оба RRF-балла и поднимается выше.
        scores: dict[tuple, float] = {}
        objects: dict[tuple, RetrievedChunk] = {}

        def _accumulate(obj: RetrievedChunk, rank: int) -> None:
            key = (obj.text[:80], obj.document_id, obj.chunk_index)
            objects.setdefault(key, obj)
            scores[key] = scores.get(key, 0.0) + self._rrf(rank)

        for rank, hit in enumerate(dense_hits):
            _accumulate(
                RetrievedChunk(
                    text=hit.text,
                    score=hit.score,
                    document_id=hit.document_id,
                    chunk_index=hit.payload.get("chunk_index"),
                    title=hit.payload.get("title", ""),
                    source_uri=hit.payload.get("source_uri", ""),
                    source_type=hit.payload.get("source_type", ""),
                    priority=int(hit.payload.get("priority", 2) or 2),
                ),
                rank,
            )

        for rank, (idx, _s) in enumerate(sparse_hits):
            meta = self._bm25_meta[idx]
            _accumulate(
                RetrievedChunk(
                    text=meta["text"],
                    score=float(_s),
                    document_id=meta.get("document_id"),
                    chunk_index=meta.get("index"),
                    title=meta.get("title", ""),
                    source_uri=meta.get("source_uri", ""),
                    source_type=meta.get("source_type", ""),
                    priority=int(meta.get("priority", 2) or 2),
                ),
                rank,
            )

        sorted_keys = sorted(scores, key=lambda k: scores[k], reverse=True)
        return [objects[k] for k in sorted_keys[:top_k]]


@lru_cache(maxsize=1)
def get_retriever() -> HybridRetriever:
    return HybridRetriever()
