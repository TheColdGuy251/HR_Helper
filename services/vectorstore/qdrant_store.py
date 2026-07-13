from __future__ import annotations

import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable

from qdrant_client import QdrantClient, models

from config import settings
from utils.logger import logger


@dataclass
class SearchHit:
    chunk_id: str
    score: float
    text: str
    document_id: int | None
    payload: dict[str, Any]


class QdrantStore:
    def __init__(self, collection: str | None = None):
        self.collection = collection or settings.qdrant_collection
        self.client = QdrantClient(
            url=settings.qdrant_url,
            api_key=settings.qdrant_api_key or None,
            timeout=30.0,
        )
        self._ready = False

    def ensure_collection(self, dim: int) -> None:
        if self._ready:
            return
        existing = {c.name for c in self.client.get_collections().collections}
        if self.collection not in existing:
            logger.info("Создаю Qdrant-коллекцию {} dim={}", self.collection, dim)
            self.client.create_collection(
                collection_name=self.collection,
                vectors_config=models.VectorParams(
                    size=dim,
                    distance=models.Distance.COSINE,
                ),
                # Скалярная квантизация — экономия памяти в 4 раза при минимальной потере качества
                quantization_config=models.ScalarQuantization(
                    scalar=models.ScalarQuantizationConfig(
                        type=models.ScalarType.INT8,
                        always_ram=True,
                    )
                ),
                hnsw_config=models.HnswConfigDiff(m=16, ef_construct=128),
            )

        # Индексы по полям payload. Создаём идемпotently и для уже существующей
        # коллекции — иначе новый индекс (article_no) не появится без пересоздания
        # коллекции. create_payload_index на уже проиндексированном поле — no-op.
        for field_name, schema in (
            ("document_id", models.PayloadSchemaType.INTEGER),
            ("source_type", models.PayloadSchemaType.KEYWORD),
            # Номер статьи — числовой индекс: позволяет фильтровать «статья N» и
            # сортировать для «первая/последняя/первые N статей» без скана коллекции.
            ("article_no", models.PayloadSchemaType.FLOAT),
            # Заголовки статей — для компактной выборки «голов» при extreme/range.
            ("is_article_head", models.PayloadSchemaType.BOOL),
            # Обобщённые единицы (раздел/глава/пункт/§) для не-кодексных документов.
            ("unit_type", models.PayloadSchemaType.KEYWORD),
            ("unit_no", models.PayloadSchemaType.KEYWORD),
            ("unit_ord", models.PayloadSchemaType.FLOAT),
            ("is_unit_head", models.PayloadSchemaType.BOOL),
        ):
            try:
                self.client.create_payload_index(
                    collection_name=self.collection,
                    field_name=field_name,
                    field_schema=schema,
                )
            except Exception as e:
                logger.debug("payload index {} уже есть/не создан: {}", field_name, e)
        self._ready = True

    # Qdrant отказывается принимать HTTP-тело больше 32 МБ.
    # Для 768d-эмбеддингов одно upsert-сообщение из ~1300+ чанков уже перебирает лимит,
    # поэтому шлём батчами.
    _UPSERT_BATCH_SIZE = 200

    def upsert_chunks(
        self,
        document_id: int,
        chunks: Iterable[dict[str, Any]],
        vectors: Iterable[list[float]],
    ) -> list[str]:
        points: list[models.PointStruct] = []
        ids: list[str] = []
        for chunk, vec in zip(chunks, vectors):
            point_id = uuid.uuid4().hex
            ids.append(point_id)
            payload = {
                "document_id": document_id,
                "text": chunk["text"],
                "chunk_index": chunk.get("index"),
                "title": chunk.get("title", ""),
                "source_uri": chunk.get("source_uri", ""),
                "source_type": chunk.get("source_type", "local"),
                # Метаданные документа: раньше терялись здесь и «оживали» только после
                # ручного PATCH. Теперь приоритет/архив/тип/теги доходят до payload сразу.
                "priority": int(chunk.get("priority", 2) or 2),
                "is_archived": bool(chunk.get("is_archived", False)),
                "document_kind": chunk.get("document_kind"),
                "tags": list(chunk.get("tags") or []),
                # Структурные метаданные для НПА (фундамент гибкого поиска по статьям)
                "article_no": chunk.get("article_no"),
                "is_article_head": bool(chunk.get("is_article_head", False)),
                # Обобщённые единицы (раздел/глава/пункт/§) — навигация по не-кодексам
                "unit_type": chunk.get("unit_type"),
                "unit_no": chunk.get("unit_no"),
                "unit_ord": chunk.get("unit_ord"),
                "is_unit_head": bool(chunk.get("is_unit_head", False)),
            }
            points.append(models.PointStruct(id=point_id, vector=vec, payload=payload))

        for i in range(0, len(points), self._UPSERT_BATCH_SIZE):
            batch = points[i : i + self._UPSERT_BATCH_SIZE]
            self.client.upsert(collection_name=self.collection, points=batch, wait=True)
        return ids

    def search(
        self,
        query_vector: list[float],
        top_k: int = 20,
        filters: dict[str, Any] | None = None,
        include_archived: bool = False,
        tags_any: list[str] | None = None,
    ) -> list[SearchHit]:
        must: list = []
        must_not: list = []
        if filters:
            for k, v in filters.items():
                must.append(models.FieldCondition(key=k, match=models.MatchValue(value=v)))
        # По умолчанию исключаем архивные редакции — они вне поиска
        if not include_archived:
            must_not.append(
                models.FieldCondition(
                    key="is_archived", match=models.MatchValue(value=True)
                )
            )
        # Boost по тегам — фильтруем «любой из»
        if tags_any:
            should = [
                models.FieldCondition(key="tags", match=models.MatchValue(value=t))
                for t in tags_any
            ]
            flt = models.Filter(must=must, must_not=must_not, should=should)
        else:
            flt = models.Filter(must=must, must_not=must_not) if (must or must_not) else None

        result = self.client.query_points(
            collection_name=self.collection,
            query=query_vector,
            limit=top_k,
            query_filter=flt,
            with_payload=True,
        ).points

        # FALLBACK: при `should=tags` без жёсткого `must` Qdrant трактует условие как
        # фильтр, а не как boost. Если документ не имеет нужного тега — он не вернётся,
        # и мы получим пустой результат, хотя коллекция не пуста. Повторяем поиск без
        # тегов — это даёт честный семантический поиск, а приоритизация по темам уже
        # учтена в RRF/rerank по другим сигналам.
        if not result and tags_any:
            flt_no_tags = (
                models.Filter(must=must, must_not=must_not)
                if (must or must_not)
                else None
            )
            result = self.client.query_points(
                collection_name=self.collection,
                query=query_vector,
                limit=top_k,
                query_filter=flt_no_tags,
                with_payload=True,
            ).points

        hits: list[SearchHit] = []
        for r in result:
            payload = r.payload or {}
            hits.append(
                SearchHit(
                    chunk_id=str(r.id),
                    score=float(r.score),
                    text=payload.get("text", ""),
                    document_id=payload.get("document_id"),
                    payload=payload,
                )
            )
        return hits

    def fetch_chunks_by_article_no(
        self,
        article_no: float,
        document_id: int | None = None,
        limit: int = 8,
    ) -> list[SearchHit]:
        """Все чанки статьи с данным номером (заголовок + продолжения), по индексу
        article_no — без скана коллекции. Опционально сужается до документа.

        Для float используем Range(gte==lte): MatchValue по float в Qdrant ненадёжен.
        """
        must: list = [
            models.FieldCondition(
                key="article_no",
                range=models.Range(gte=article_no, lte=article_no),
            )
        ]
        if document_id is not None:
            must.append(
                models.FieldCondition(
                    key="document_id", match=models.MatchValue(value=document_id)
                )
            )
        points, _ = self.client.scroll(
            collection_name=self.collection,
            scroll_filter=models.Filter(must=must),
            limit=max(limit, 64),
            with_payload=True,
            with_vectors=False,
        )
        hits = [
            SearchHit(
                chunk_id=str(p.id),
                score=1.0,
                text=(p.payload or {}).get("text", ""),
                document_id=(p.payload or {}).get("document_id"),
                payload=p.payload or {},
            )
            for p in points
        ]
        hits.sort(key=lambda h: int((h.payload or {}).get("chunk_index", 0) or 0))
        return hits[:limit]

    def fetch_article_heads(
        self, document_id: int | None = None
    ) -> list[tuple[float, int | None]]:
        """Список (article_no, document_id) по всем заголовкам статей (is_article_head).
        Используется для «первой/последней/первых N статей» — компактно (только головы
        статей, не все чанки) и по индексу. Возвращается отсортированным по article_no.
        """
        must: list = [
            models.FieldCondition(
                key="is_article_head", match=models.MatchValue(value=True)
            )
        ]
        if document_id is not None:
            must.append(
                models.FieldCondition(
                    key="document_id", match=models.MatchValue(value=document_id)
                )
            )
        out: list[tuple[float, int | None]] = []
        offset = None
        while True:
            points, offset = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=models.Filter(must=must),
                limit=512,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            for p in points:
                pay = p.payload or {}
                no = pay.get("article_no")
                if no is None:
                    continue
                try:
                    out.append((float(no), pay.get("document_id")))
                except (TypeError, ValueError):
                    continue
            if not offset:
                break
        out.sort(key=lambda x: x[0])
        return out

    def fetch_chunks_by_unit(
        self,
        unit_type: str,
        unit_no: str,
        document_id: int | None = None,
        limit: int = 8,
    ) -> list[SearchHit]:
        """Все чанки структурной единицы (раздел/глава/пункт N) по индексам unit_type+unit_no."""
        must: list = [
            models.FieldCondition(key="unit_type", match=models.MatchValue(value=unit_type)),
            models.FieldCondition(key="unit_no", match=models.MatchValue(value=unit_no)),
        ]
        if document_id is not None:
            must.append(
                models.FieldCondition(key="document_id", match=models.MatchValue(value=document_id))
            )
        points, _ = self.client.scroll(
            collection_name=self.collection,
            scroll_filter=models.Filter(must=must),
            limit=max(limit, 64),
            with_payload=True,
            with_vectors=False,
        )
        hits = [
            SearchHit(
                chunk_id=str(p.id),
                score=1.0,
                text=(p.payload or {}).get("text", ""),
                document_id=(p.payload or {}).get("document_id"),
                payload=p.payload or {},
            )
            for p in points
        ]
        hits.sort(key=lambda h: int((h.payload or {}).get("chunk_index", 0) or 0))
        return hits[:limit]

    def fetch_unit_heads(
        self, unit_type: str, document_id: int | None = None
    ) -> list[tuple[str, float, int | None]]:
        """Заголовки единиц данного типа: список (unit_no, unit_ord, document_id),
        отсортированный по unit_ord. Для extreme/range/count по разделам/главам/пунктам."""
        must: list = [
            models.FieldCondition(key="unit_type", match=models.MatchValue(value=unit_type)),
            models.FieldCondition(key="is_unit_head", match=models.MatchValue(value=True)),
        ]
        if document_id is not None:
            must.append(
                models.FieldCondition(key="document_id", match=models.MatchValue(value=document_id))
            )
        out: list[tuple[str, float, int | None]] = []
        offset = None
        while True:
            points, offset = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=models.Filter(must=must),
                limit=512,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            for p in points:
                pay = p.payload or {}
                no = pay.get("unit_no")
                if no is None:
                    continue
                try:
                    ordv = float(pay.get("unit_ord") if pay.get("unit_ord") is not None else 0.0)
                except (TypeError, ValueError):
                    ordv = 0.0
                out.append((str(no), ordv, pay.get("document_id")))
            if not offset:
                break
        out.sort(key=lambda x: x[1])
        return out

    def fetch_chunks_by_text_prefix(
        self,
        prefix_lower: str,
        limit: int = 5,
        digit_boundary: bool = False,
    ) -> list[SearchHit]:
        """Сканирует коллекцию и возвращает чанки, чей текст начинается с prefix_lower
        (case-insensitive). Используется для точного поиска по «Статья N.».

        digit_boundary=True требует, чтобы сразу после префикса НЕ шла цифра или
        «.цифра»: иначе «статья 28» матчит и «Статья 280», «Статья 28.1» — в контекст
        уезжают чужие статьи, и модель отказывается цитировать нужную."""
        all_points: list = []
        offset = None
        while True:
            points, offset = self.client.scroll(
                collection_name=self.collection,
                limit=512,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            all_points.extend(points)
            if not offset:
                break

        def _boundary_ok(txt_lower: str) -> bool:
            if not digit_boundary:
                return True
            tail = txt_lower[len(prefix_lower):]
            if tail[:1].isdigit():
                return False  # «статья 28» × «статья 280»
            if tail[:1] == "." and tail[1:2].isdigit():
                return False  # «статья 28» × «статья 28.1»
            return True

        hits: list[SearchHit] = []
        for p in all_points:
            txt = ((p.payload or {}).get("text") or "").lstrip()
            if txt.lower().startswith(prefix_lower) and _boundary_ok(txt.lower()):
                hits.append(
                    SearchHit(
                        chunk_id=str(p.id),
                        score=1.0,
                        text=txt,
                        document_id=(p.payload or {}).get("document_id"),
                        payload=p.payload or {},
                    )
                )
        # Сортируем по chunk_index, чтобы порядок был стабильным
        hits.sort(key=lambda h: int((h.payload or {}).get("chunk_index", 0) or 0))
        return hits[:limit]

    def fetch_document_chunks(
        self,
        document_id: int,
        limit: int = 5,
        order: str = "asc",
    ) -> list[SearchHit]:
        """Достаёт первые/последние N чанков документа В ПОРЯДКЕ chunk_index.
        Используется для «каталожных» запросов («первые 3 статьи», «последние 5 пунктов»).

        Реализация через Qdrant scroll (без сортировки на стороне сервера —
        в нашей версии qdrant-client 1.18 order_by нестабилен), забираем все
        чанки документа и сортируем в Python.
        """
        flt = models.Filter(
            must=[models.FieldCondition(key="document_id", match=models.MatchValue(value=document_id))]
        )
        all_points: list = []
        offset = None
        while True:
            points, offset = self.client.scroll(
                collection_name=self.collection,
                scroll_filter=flt,
                limit=512,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            all_points.extend(points)
            if not offset:
                break

        def _key(p) -> int:
            try:
                return int((p.payload or {}).get("chunk_index", 0) or 0)
            except (TypeError, ValueError):
                return 0

        all_points.sort(key=_key, reverse=(order == "desc"))
        slice_ = all_points[:limit]
        return [
            SearchHit(
                chunk_id=str(p.id),
                score=1.0,
                text=(p.payload or {}).get("text", ""),
                document_id=document_id,
                payload=p.payload or {},
            )
            for p in slice_
        ]

    def set_priority(self, document_id: int, priority: int) -> None:
        """Обновляет payload-поле 'priority' у всех чанков документа без переиндексации."""
        # qdrant-client ≥1.11 переименовал параметр points_selector → points.
        # Передаём Filter напрямую (points принимает Filter/список id/селектор).
        self.client.set_payload(
            collection_name=self.collection,
            payload={"priority": int(priority)},
            points=models.Filter(
                must=[
                    models.FieldCondition(
                        key="document_id",
                        match=models.MatchValue(value=document_id),
                    )
                ]
            ),
            wait=True,
        )

    def is_alive(self) -> bool:
        """Доступен ли сервер Qdrant (быстрая проверка для диагностики)."""
        try:
            self.client.get_collections()
            return True
        except Exception:
            return False

    def delete_by_document(self, document_id: int) -> None:
        self.client.delete(
            collection_name=self.collection,
            points_selector=models.FilterSelector(
                filter=models.Filter(
                    must=[models.FieldCondition(key="document_id", match=models.MatchValue(value=document_id))]
                )
            ),
        )


@lru_cache(maxsize=1)
def get_store() -> QdrantStore:
    return QdrantStore()
