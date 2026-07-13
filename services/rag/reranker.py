from __future__ import annotations

from functools import lru_cache

from config import settings
from utils.logger import logger
from services.rag.retriever import RetrievedChunk


class Reranker:
    """ONNX-реранкер через FastEmbed (cross-encoder)."""

    def __init__(self):
        self._model = None
        self.model_name = settings.rerank_model

    def _load(self):
        if self._model is not None:
            return
        try:
            from fastembed.rerank.cross_encoder import TextCrossEncoder

            supported = {m["model"] for m in TextCrossEncoder.list_supported_models()}
            # Только МУЛЬТИЯЗЫЧНЫЕ модели — англоязычный fallback на русском хуже,
            # чем вообще без реранка (портит порядок RRF). Если ни одна не доступна —
            # отключаем реранк и используем порядок гибридного поиска как есть.
            candidates = [
                self.model_name,
                "BAAI/bge-reranker-base",
                "jinaai/jina-reranker-v2-base-multilingual",
            ]
            for name in candidates:
                if name in supported:
                    logger.info("Загружаю реранкер: {}", name)
                    self._model = TextCrossEncoder(
                        model_name=name,
                        cache_dir=str(settings.fastembed_cache_dir),
                    )
                    self.model_name = name
                    return
            raise RuntimeError("Нет доступных мультиязычных моделей реранкера")
        except Exception as e:
            logger.warning(
                "Реранкер не загружен ({}). Будет использован порядок гибридного поиска (RRF).", e
            )
            self._model = False  # маркер невозможности использовать

    def rerank(
        self,
        query: str,
        chunks: list[RetrievedChunk],
        top_n: int | None = None,
    ) -> list[RetrievedChunk]:
        top_n = top_n or settings.rerank_top_n
        if not chunks:
            return []

        self._load()
        if not self._model:
            return chunks[:top_n]

        # Ограничиваем число кандидатов: кросс-энкодер на CPU дорог. Порядок RRF уже
        # ставит релевантное вперёд, поэтому хвост можно не реранкировать.
        chunks = chunks[: settings.rerank_input_max]
        texts = [c.text for c in chunks]
        try:
            scores = list(self._model.rerank(query, texts))
        except Exception as e:
            logger.warning("Сбой реранкера: {}", e)
            return chunks[:top_n]

        # Boost по приоритету документа: 1=×0.8, 2=×1.0, 3=×1.3.
        # Применяется ПОСЛЕ реранкинга, чтобы реальная релевантность всё ещё была первичной.
        boost = {1: 0.8, 2: 1.0, 3: 1.3}
        for c, s in zip(chunks, scores):
            c.score = float(s) * boost.get(int(c.priority or 2), 1.0)
        chunks_sorted = sorted(chunks, key=lambda c: c.score, reverse=True)
        return chunks_sorted[:top_n]


@lru_cache(maxsize=1)
def get_reranker() -> Reranker:
    return Reranker()
