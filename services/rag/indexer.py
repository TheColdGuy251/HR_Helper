from __future__ import annotations

import hashlib
import threading
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from data.kb_documents import KBDocument
from data.kb_links import KBLink
from services.embeddings import get_encoder
from services.parsers import ParsedDocument, parse_file, parse_url
from services.parsers.base import derive_title
from services.rag.chunker import split_text
from services.rag.link_parser import extract_links
from services.rag.retriever import get_retriever
from services.vectorstore import get_store
from utils.logger import logger


def _sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# Тяжёлая часть индексации (эмбеддинги на всех ядрах CPU + перестройка BM25) сериализуется
# ГЛОБАЛЬНО: параллельные индексации нескольких документов оверсабскрайбят процессор и
# «подвешивают» всю машину/страницу. Один документ за раз — остальные ждут очереди.
# Разные пути (загрузка, 1С-импорт, планировщик веб-источников) делят один и тот же лок.
_INDEX_LOCK = threading.Lock()

# ─── Прогресс индексации (для интерактивности в UI): doc_id → снапшот стадии ───
_progress: dict[int, dict] = {}
_progress_lock = threading.Lock()

_STAGE_LABELS = {
    "queued": "в очереди",
    "parsing": "извлечение текста",
    "chunking": "разбиение на чанки",
    "embedding": "векторизация",
    "saving": "сохранение в индекс",
    "links": "граф ссылок",
    "finishing": "обновление поиска",
}
# Базовый процент на входе в стадию; embedding (самая долгая) растянута на 15–90%.
_STAGE_BASE = {
    "queued": 2, "parsing": 6, "chunking": 12, "embedding": 15,
    "saving": 92, "links": 95, "finishing": 98,
}


def _set_progress(doc_id: int, stage: str, done: int = 0, total: int = 0) -> None:
    pct = _STAGE_BASE.get(stage, 0)
    if stage == "embedding" and total:
        pct = 15 + int(75 * done / total)
    with _progress_lock:
        _progress[doc_id] = {
            "stage": stage,
            "label": _STAGE_LABELS.get(stage, stage),
            "done": done,
            "total": total,
            "percent": min(pct, 99),
        }


def _clear_progress(doc_id: int) -> None:
    with _progress_lock:
        _progress.pop(doc_id, None)


def get_progress(doc_id: int) -> dict | None:
    """Текущий прогресс индексации документа (None — не индексируется)."""
    with _progress_lock:
        p = _progress.get(doc_id)
        return dict(p) if p else None


class Indexer:
    def __init__(self):
        self.encoder = get_encoder()
        self.store = get_store()
        self.retriever = get_retriever()

    def _persist_kb_doc(
        self,
        db: Session,
        parsed: ParsedDocument,
        file_hash: str | None,
        doc: KBDocument | None = None,
    ) -> KBDocument:
        # Имя файла «название.pdf» — явно сохраняем в extra, чтобы показывать в КБ
        # и разрешать ссылки на документ по имени в чате (#12).
        extra = dict(parsed.extra or {})
        if parsed.source_type == "local" and parsed.source_uri:
            extra.setdefault("filename", Path(parsed.source_uri).name)

        if doc is None:
            doc = KBDocument(
                title=parsed.title or parsed.source_uri,
                source_type=parsed.source_type,
                source_uri=parsed.source_uri,
                file_hash=file_hash,
                mime_type=parsed.mime_type,
                status="parsing",
                extra=extra,
            )
            db.add(doc)
        else:
            # Обновляем заранее созданную «pending»-запись (фоновая индексация)
            doc.title = parsed.title or parsed.source_uri
            doc.source_type = parsed.source_type
            doc.source_uri = parsed.source_uri
            doc.file_hash = file_hash
            doc.mime_type = parsed.mime_type
            doc.extra = extra
            doc.status = "parsing"
        db.commit()
        db.refresh(doc)
        return doc

    def _index_parsed(
        self,
        db: Session,
        parsed: ParsedDocument,
        file_hash: str | None,
        doc: KBDocument | None = None,
    ) -> KBDocument:
        if not parsed.text.strip():
            raise ValueError("Документ пустой после парсинга")

        # Человекочитаемое название из шапки документа вместо имени файла-слага —
        # улучшает цитирование и разрешение doc_hint при множестве документов.
        better_title = derive_title(parsed.text, parsed.title)
        if better_title:
            parsed.title = better_title

        kb_doc = self._persist_kb_doc(db, parsed, file_hash, doc=doc)
        # Сохраняем полный извлечённый текст для предпросмотра (для веб-страниц файла
        # на диске нет — только так их можно показать «как распарсилось»).
        kb_doc.content = parsed.text

        # А8: в ОБЩЕЙ БЗ не должно быть ПДн — эвристический скан (списки ФИО,
        # СНИЛС/паспорт/дата рождения). Не блокируем индексацию, но помечаем
        # документ предупреждением (бейдж в /kb) — решает редактор.
        try:
            from services.pii.scan import scan_pii_signals

            pii = scan_pii_signals(parsed.text)
            extra = dict(kb_doc.extra or {})
            if pii:
                extra["pii_warning"] = pii
                logger.warning(
                    "[PII-SCAN] документ {} похож на ПДн: {} (ФИО: {})",
                    kb_doc.id, pii["reason"], pii["fio_count"],
                )
            else:
                extra.pop("pii_warning", None)
            kb_doc.extra = extra or None
        except Exception as e:
            logger.warning("[PII-SCAN] не удался для документа {}: {}", kb_doc.id, e)

        # Тяжёлая индексация — строго по одному документу за раз (см. _INDEX_LOCK),
        # чтобы одновременные загрузки не «положили» CPU и UI.
        _INDEX_LOCK.acquire()
        try:
            _set_progress(kb_doc.id, "chunking")
            chunks = split_text(parsed.text)
            if not chunks:
                raise ValueError("Не удалось получить чанки")

            tags = list(kb_doc.tags or [])
            chunk_payloads = [
                {
                    "text": c.text,
                    "index": c.index,
                    "title": parsed.title,
                    "source_uri": parsed.source_uri,
                    "source_type": parsed.source_type,
                    "document_id": kb_doc.id,
                    "priority": int(kb_doc.priority or 2),
                    "is_archived": bool(kb_doc.is_archived),
                    "document_kind": kb_doc.document_kind,
                    "tags": tags,
                    # Структурные метаданные из чанкера (для нормативных актов)
                    "article_no": c.article_no,
                    "is_article_head": c.is_article_head,
                    # Обобщённые единицы (раздел/глава/пункт/§) для не-кодексных документов
                    "unit_type": c.unit_type,
                    "unit_no": c.unit_no,
                    "unit_ord": c.unit_ord,
                    "is_unit_head": c.is_unit_head,
                }
                for c in chunks
            ]

            # Векторизация батчами — прогресс виден в UI («N/M чанков»).
            texts = [c["text"] for c in chunk_payloads]
            _set_progress(kb_doc.id, "embedding", 0, len(texts))
            vectors: list[list[float]] = []
            _EMBED_BATCH = 64
            for i in range(0, len(texts), _EMBED_BATCH):
                vectors.extend(self.encoder.encode(texts[i:i + _EMBED_BATCH], is_query=False))
                _set_progress(kb_doc.id, "embedding", min(i + _EMBED_BATCH, len(texts)), len(texts))

            _set_progress(kb_doc.id, "saving", len(texts), len(texts))
            self.store.ensure_collection(dim=len(vectors[0]))
            # Точки получают НОВЫЕ uuid — старые точки документа обязаны быть удалены,
            # иначе переиндексация задваивает каждую статью в поиске.
            try:
                self.store.delete_by_document(kb_doc.id)
            except Exception as e:
                logger.warning("[INDEX] не удалось удалить старые точки doc {}: {}", kb_doc.id, e)
            self.store.upsert_chunks(kb_doc.id, chunk_payloads, vectors)

            # Парсим внутренние ссылки и сохраняем в kb_links
            _set_progress(kb_doc.id, "links", len(texts), len(texts))
            db.query(KBLink).filter(KBLink.from_doc_id == kb_doc.id).delete()
            link_rows: list[KBLink] = []
            for c in chunks:
                for link in extract_links(c.text, chunk_index=c.index):
                    # Заголовок «Статья N. …» в начале чанка — не ссылка на себя.
                    if link.kind == "article" and c.article_no is not None:
                        try:
                            if float(link.number) == float(c.article_no):
                                continue
                        except ValueError:
                            pass
                    link_rows.append(
                        KBLink(
                            from_doc_id=kb_doc.id,
                            from_chunk_index=link.chunk_index,
                            target_kind=link.kind,
                            target_number=link.number,
                            target_doc_hint=link.doc_hint,
                        )
                    )
            if link_rows:
                db.bulk_save_objects(link_rows)
                logger.info("[INDEX] doc {} — извлечено ссылок: {}", kb_doc.id, len(link_rows))

            kb_doc.status = "indexed"
            kb_doc.chunks_count = len(chunks)
            kb_doc.indexed_at = datetime.utcnow()
            db.commit()
            # Каталог «связанных документов» бота устарел — перечитает при след. запросе.
            try:
                from services.rag.blank_forms import get_catalog
                get_catalog().invalidate()
            except Exception:
                pass

            # Перестроим BM25-индекс
            _set_progress(kb_doc.id, "finishing", len(chunks), len(chunks))
            self._refresh_bm25(db)

            logger.info("Документ {} проиндексирован, чанков: {}", kb_doc.id, len(chunks))
            return kb_doc

        except Exception as e:
            kb_doc.status = "failed"
            kb_doc.error = str(e)
            db.commit()
            raise
        finally:
            _clear_progress(kb_doc.id)
            _INDEX_LOCK.release()

    def index_file(self, db: Session, path: str | Path) -> KBDocument:
        path = Path(path)
        file_hash = _sha256_file(path)

        existing = db.query(KBDocument).filter(KBDocument.file_hash == file_hash).first()
        if existing and existing.status == "indexed":
            logger.info("Файл {} уже проиндексирован (id={})", path.name, existing.id)
            return existing

        parsed = parse_file(path)
        return self._index_parsed(db, parsed, file_hash)

    def create_pending_file(self, db: Session, path: str | Path) -> KBDocument:
        """Мгновенно создаёт запись со статусом pending — чтобы файл сразу
        отобразился в списке, пока индексация идёт в фоне."""
        path = Path(path)
        doc = KBDocument(
            title=path.name,
            source_type="local",
            source_uri=str(path),
            status="pending",
        )
        db.add(doc)
        db.commit()
        db.refresh(doc)
        _set_progress(doc.id, "queued")
        return doc

    def reindex_content(self, db: Session, doc_id: int, new_text: str) -> KBDocument:
        """А6: правка текста документа из UI — сохраняет новый текст и полностью
        переиндексирует документ (чанки, эмбеддинги, ссылки, BM25). Название и
        метаданные документа сохраняются как есть (пользователь их мог поправить)."""
        doc = db.get(KBDocument, doc_id)
        if not doc:
            raise ValueError("Документ не найден")
        keep_title = doc.title
        parsed = ParsedDocument(
            text=new_text,
            title=keep_title,
            source_uri=doc.source_uri,
            source_type=doc.source_type,
            mime_type=doc.mime_type,
        )
        try:
            self._index_parsed(db, parsed, doc.file_hash, doc=doc)
        finally:
            # derive_title мог «улучшить» название из нового текста — возвращаем
            # пользовательское; пометка о ручной правке остаётся в extra.
            doc = db.get(KBDocument, doc_id)
            if doc:
                doc.title = keep_title
                extra = dict(doc.extra or {})
                extra["edited_at"] = datetime.utcnow().isoformat(timespec="seconds")
                doc.extra = extra
                db.commit()
        logger.info("[INDEX] документ {} переиндексирован после правки текста", doc_id)
        return doc

    def index_pending(self, db: Session, doc_id: int, path: str | Path) -> None:
        """Фоновая индексация заранее созданной pending-записи. Любая ошибка
        переводит документ в статус failed, но НЕ роняет сервис."""
        path = Path(path)
        doc = db.get(KBDocument, doc_id)
        if not doc:
            return
        try:
            _set_progress(doc_id, "parsing")
            file_hash = _sha256_file(path)
            existing = (
                db.query(KBDocument)
                .filter(
                    KBDocument.file_hash == file_hash,
                    KBDocument.status == "indexed",
                    KBDocument.id != doc.id,
                )
                .first()
            )
            if existing:
                logger.info("Файл {} уже проиндексирован (id={}), удаляю дубль", path.name, existing.id)
                db.delete(doc)
                db.commit()
                return
            parsed = parse_file(path)
            self._index_parsed(db, parsed, file_hash, doc=doc)
        except Exception as e:
            logger.exception("Индексация {} упала: {}", path.name, e)
            try:
                doc = db.get(KBDocument, doc_id)
                if doc:
                    doc.status = "failed"
                    doc.error = str(e)[:500]
                    db.commit()
            except Exception:
                db.rollback()
        finally:
            _clear_progress(doc_id)

    def index_url(self, db: Session, url: str) -> KBDocument:
        parsed = parse_url(url)
        text_hash = _sha256_text(parsed.text)

        existing = (
            db.query(KBDocument)
            .filter(KBDocument.source_uri == url, KBDocument.file_hash == text_hash)
            .first()
        )
        if existing and existing.status == "indexed":
            logger.info("URL {} без изменений, пропускаю", url)
            return existing

        # Контент страницы изменился (или прошлая попытка не завершилась): удаляем
        # старые версии этого URL, чтобы не копить дубли в базе знаний. Прежний текст
        # запоминаем — он нужен для diff в системном уведомлении об обновлении.
        stale = (
            db.query(KBDocument)
            .filter(KBDocument.source_uri == url, KBDocument.source_type == "web")
            .all()
        )
        old_content: str | None = None
        for old in stale:
            if old.status == "indexed" and (old.content or "").strip() and old_content is None:
                old_content = old.content
            try:
                self.delete_document(db, old.id)
            except Exception as e:
                logger.warning("Не удалось удалить старую версию {}: {}", url, e)

        doc = self._index_parsed(db, parsed, text_hash)

        # Настоящее ОБНОВЛЕНИЕ (была проиндексированная версия с другим текстом) →
        # системное уведомление для всех пользователей (см. /api/notifications).
        if old_content is not None and old_content.strip() != (doc.content or "").strip():
            try:
                from data.notifications import Notification
                from services import notify

                n = Notification(
                    kind="web_update",
                    title=doc.title or url,
                    body=f"Парсер обнаружил изменение веб-страницы: {url}",
                    document_id=doc.id,
                    extra={"old_content": old_content, "url": url},
                )
                db.add(n)
                db.commit()
                notify.publish_all({"type": "system_notification", "kind": "web_update", "id": n.id})
                logger.info("[NOTIFY] web_update: документ {} ({})", doc.id, url)
            except Exception as e:
                logger.warning("Не удалось создать уведомление об обновлении {}: {}", url, e)

        return doc

    def delete_document(self, db: Session, doc_id: int) -> None:
        doc = db.get(KBDocument, doc_id)
        if not doc:
            return

        # 1) Векторы из Qdrant (все чанки документа)
        try:
            self.store.delete_by_document(doc_id)
        except Exception as e:
            logger.warning("Qdrant delete для doc {} не удался: {}", doc_id, e)

        # 2) Граф ссылок kb_links (на случай, если FK-CASCADE не сработает)
        try:
            db.query(KBLink).filter(KBLink.from_doc_id == doc_id).delete(synchronize_session=False)
        except Exception as e:
            logger.warning("Удаление kb_links для doc {} не удалось: {}", doc_id, e)

        # 3) Файл с диска (только локальные файлы внутри docs/, path-traversal-safe)
        if doc.source_type == "local" and doc.source_uri:
            try:
                from config import settings

                path = Path(doc.source_uri).resolve()
                path.relative_to(settings.docs_dir.resolve())
                path.unlink(missing_ok=True)
            except (ValueError, OSError) as e:
                logger.warning("Не удалось удалить файл {}: {}", doc.source_uri, e)

        # 4) Запись в БД
        db.delete(doc)
        db.commit()

        # 5) Перестроить BM25 (документа больше нет в индексе)
        self._refresh_bm25(db)
        try:
            from services.rag.blank_forms import get_catalog
            get_catalog().invalidate()
        except Exception:
            pass
        logger.info("Документ {} удалён (Qdrant + kb_links + файл + БД)", doc_id)

    def _refresh_bm25(self, db: Session) -> None:
        """Перестраивает BM25 индекс на основе текущих чанков из Qdrant.

        Для простоты используем payload-выгрузку через scroll Qdrant.
        """
        store = self.store
        client = store.client
        offset = None
        all_payloads: list[dict] = []
        try:
            while True:
                points, offset = client.scroll(
                    collection_name=store.collection,
                    limit=512,
                    offset=offset,
                    with_payload=True,
                    with_vectors=False,
                )
                for p in points:
                    payload = p.payload or {}
                    if not payload.get("text"):
                        continue
                    all_payloads.append(
                        {
                            "text": payload.get("text", ""),
                            "index": payload.get("chunk_index"),
                            "title": payload.get("title", ""),
                            "source_uri": payload.get("source_uri", ""),
                            "source_type": payload.get("source_type", ""),
                            "document_id": payload.get("document_id"),
                            "priority": int(payload.get("priority", 2) or 2),
                            "chunk_id": str(p.id),
                        }
                    )
                if not offset:
                    break

            # Санация «призраков»: точки, чей document_id отсутствует в SQL среди
            # indexed-документов (документ удалили/переиндексировали, а Qdrant в тот
            # момент был недоступен). Призраки засоряют поиск дублями статей и
            # контентом удалённых документов. Защита: чистим только когда в SQL есть
            # хотя бы один indexed-документ — иначе это, скорее всего, чужая/пустая
            # БД (например, тестовая) и массовое удаление недопустимо.
            try:
                from data.db_session import create_session
                from data.kb_documents import KBDocument as _KBDoc

                s = create_session()
                try:
                    valid_ids = {
                        row.id for row in s.query(_KBDoc.id).filter(_KBDoc.status == "indexed").all()
                    }
                finally:
                    s.close()
                point_doc_ids = {
                    p["document_id"] for p in all_payloads if p.get("document_id") is not None
                }
                orphans = point_doc_ids - valid_ids
                if valid_ids and orphans:
                    logger.warning(
                        "[INDEX] в Qdrant найдены точки удалённых документов {} — удаляю",
                        sorted(orphans),
                    )
                    for oid in orphans:
                        try:
                            store.delete_by_document(oid)
                        except Exception as e:
                            logger.warning("[INDEX] не удалось удалить призрака doc={}: {}", oid, e)
                    all_payloads = [
                        p for p in all_payloads if p.get("document_id") in valid_ids
                    ]

                # Дубли той же (document_id, chunk_index): документ переиндексировали
                # без удаления старых точек (новые uuid) — каждая статья задвоена.
                if valid_ids:
                    seen_keys: set[tuple] = set()
                    dup_point_ids: list[str] = []
                    deduped: list[dict] = []
                    for p in all_payloads:
                        key = (p.get("document_id"), p.get("index"))
                        if key[0] is not None and key[1] is not None and key in seen_keys:
                            dup_point_ids.append(p["chunk_id"])
                            continue
                        seen_keys.add(key)
                        deduped.append(p)
                    if dup_point_ids:
                        logger.warning(
                            "[INDEX] в Qdrant найдено {} точек-дублей — удаляю", len(dup_point_ids)
                        )
                        from qdrant_client import models as qm

                        for i in range(0, len(dup_point_ids), 500):
                            client.delete(
                                collection_name=store.collection,
                                points_selector=qm.PointIdsList(
                                    points=dup_point_ids[i:i + 500]
                                ),
                            )
                        all_payloads = deduped
            except Exception as e:
                logger.warning("[INDEX] санация призраков не удалась: {}", e)

            self.retriever.rebuild_bm25(all_payloads)
        except Exception as e:
            logger.warning("Не получилось обновить BM25: {}", e)


_indexer: Indexer | None = None


def get_indexer() -> Indexer:
    global _indexer
    if _indexer is None:
        _indexer = Indexer()
    return _indexer
