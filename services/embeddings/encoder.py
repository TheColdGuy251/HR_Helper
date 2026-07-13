from __future__ import annotations

from functools import lru_cache
from typing import Iterable

from config import settings
from utils.logger import logger


class Encoder:
    """Обёртка над FastEmbed: ONNX INT8 на CPU. Lazy-load."""

    def __init__(self, model_name: str | None = None):
        self.model_name = model_name or settings.embed_model
        self._model = None
        self._dim: int | None = None

    def _load(self):
        if self._model is not None:
            return
        from fastembed import TextEmbedding

        # Список поддерживаемых моделей FastEmbed
        supported = {m["model"] for m in TextEmbedding.list_supported_models()}

        # FastEmbed multilingual: ставим mpnet (768d, лучшее качество для RU) первым.
        # e5-large на FastEmbed разделён на части, бывает ломается при первом запуске.
        candidates: list[str] = []
        if self.model_name in supported:
            candidates.append(self.model_name)
        for name in (
            "sentence-transformers/paraphrase-multilingual-mpnet-base-v2",
            "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            "intfloat/multilingual-e5-large",
        ):
            if name in supported and name not in candidates:
                candidates.append(name)

        # Число ONNX-потоков: 0 → авто «оставить одно ядро свободным». Так индексация
        # большого документа не занимает весь CPU и не «вешает» интерфейс/машину.
        import os

        threads = settings.embed_threads
        if threads <= 0:
            threads = max(1, (os.cpu_count() or 2) - 1)
        logger.info("Эмбеддер: потоков ONNX = {}", threads)

        last_err: Exception | None = None
        for name in candidates:
            try:
                logger.info("Загружаю эмбеддер: {}", name)
                self._model = TextEmbedding(
                    model_name=name,
                    threads=threads,
                    cache_dir=str(settings.fastembed_cache_dir),
                )
                self.model_name = name
                return
            except Exception as e:  # pragma: no cover
                logger.warning("Не получилось загрузить {}: {}", name, e)
                last_err = e
        raise RuntimeError(f"Не удалось загрузить ни одну embedding-модель: {last_err}")

    def encode(self, texts: Iterable[str], is_query: bool = False) -> list[list[float]]:
        self._load()
        texts = list(texts)
        if not texts:
            return []

        # e5-семейство требует префиксов; для bge-m3 — не обязательно
        if "e5" in self.model_name.lower():
            prefix = "query: " if is_query else "passage: "
            texts = [prefix + t for t in texts]

        if is_query:
            # FastEmbed имеет .query_embed для совместимых моделей; fallback на .embed
            try:
                gen = self._model.query_embed(texts)
            except (AttributeError, Exception):
                gen = self._model.embed(texts)
        else:
            gen = self._model.embed(texts)

        return [vec.tolist() if hasattr(vec, "tolist") else list(vec) for vec in gen]

    def encode_one(self, text: str, is_query: bool = False) -> list[float]:
        return self.encode([text], is_query=is_query)[0]

    @property
    def dim(self) -> int:
        if self._dim is not None:
            return self._dim
        sample = self.encode_one("проверка")
        self._dim = len(sample)
        return self._dim


@lru_cache(maxsize=1)
def get_encoder() -> Encoder:
    return Encoder()
