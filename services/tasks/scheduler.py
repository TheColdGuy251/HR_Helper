from __future__ import annotations

from datetime import datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from data.db_session import create_session
from data.kb_sources import KBSource
from services.rag.indexer import get_indexer
from utils.logger import logger


_scheduler: BackgroundScheduler | None = None


def _refresh_web_sources_job() -> None:
    db = create_session()
    try:
        now = datetime.utcnow()
        sources = db.query(KBSource).filter(KBSource.is_enabled == True).all()  # noqa: E712
        indexer = get_indexer()
        for s in sources:
            if s.last_crawled_at and now - s.last_crawled_at < timedelta(hours=s.refresh_interval_hours):
                continue
            try:
                logger.info("Парсинг источника: {}", s.url)
                indexer.index_url(db, s.url)
                s.last_status = "ok"
            except Exception as e:
                logger.warning("Источник {} упал: {}", s.url, e)
                s.last_status = f"error: {e}"
            s.last_crawled_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()


def _sync_archived_payload(doc_id: int) -> None:
    """Проставляет is_archived=True на чанках документа в Qdrant (исключение из поиска)."""
    from qdrant_client import models as qm

    from services.vectorstore import get_store

    store = get_store()
    store.client.set_payload(
        collection_name=store.collection,
        payload={"is_archived": True},
        points=qm.Filter(must=[
            qm.FieldCondition(key="document_id", match=qm.MatchValue(value=doc_id))
        ]),
        wait=True,
    )


# Документы «живут 3–5 лет, обновление ≥1 раз/год» (протокол): старше N лет —
# напоминание о проверке актуальности (повторно — не чаще раза в год).
_STALE_YEARS = 3
_RENOTIFY_DAYS = 365


def check_documents_freshness_job() -> None:
    """А7: контроль актуальности БЗ.

    1) effective_to истёк → автоархив (вне retrieval) + системное уведомление;
    2) документ старше _STALE_YEARS лет (по effective_from, иначе по дате
       загрузки) → уведомление «проверьте актуальность» (раз в год на документ,
       пометка в extra.stale_notified_at)."""
    from data.kb_documents import KBDocument
    from data.notifications import Notification
    from services import notify

    db = create_session()
    try:
        today = datetime.utcnow().date()
        docs = (
            db.query(KBDocument)
            .filter(KBDocument.is_archived.is_(False), KBDocument.status == "indexed")
            .all()
        )
        for doc in docs:
            try:
                if doc.effective_to and doc.effective_to < today:
                    doc.is_archived = True
                    n = Notification(
                        kind="doc_expired",
                        title=doc.title or f"Документ #{doc.id}",
                        body=(
                            f"Срок действия истёк {doc.effective_to.strftime('%d.%m.%Y')} — "
                            "документ перемещён в архив и исключён из поиска. Загрузите "
                            "актуальную редакцию или верните из архива вручную."
                        ),
                        document_id=doc.id,
                    )
                    db.add(n)
                    db.commit()
                    try:
                        _sync_archived_payload(doc.id)
                    except Exception as e:
                        logger.warning("Qdrant archive sync (doc {}) failed: {}", doc.id, e)
                    notify.publish_all({"type": "system_notification", "kind": "doc_expired", "id": n.id})
                    logger.info("[FRESHNESS] doc_expired: документ {} архивирован", doc.id)
                    continue

                base = doc.effective_from or (doc.created_at.date() if doc.created_at else None)
                if not base:
                    continue
                age_days = (today - base).days
                if age_days < _STALE_YEARS * 365:
                    continue
                extra = dict(doc.extra or {})
                last = extra.get("stale_notified_at")
                if last:
                    try:
                        if (today - datetime.strptime(last, "%Y-%m-%d").date()).days < _RENOTIFY_DAYS:
                            continue
                    except ValueError:
                        pass
                years = age_days // 365
                n = Notification(
                    kind="doc_stale",
                    title=doc.title or f"Документ #{doc.id}",
                    body=(
                        f"Документу больше {years} лет (по документам раздела — срок жизни "
                        "3–5 лет с обновлением не реже раза в год). Проверьте актуальность "
                        "и загрузите свежую редакцию, либо укажите «действует до» в метаданных."
                    ),
                    document_id=doc.id,
                )
                db.add(n)
                extra["stale_notified_at"] = today.strftime("%Y-%m-%d")
                doc.extra = extra
                db.commit()
                notify.publish_all({"type": "system_notification", "kind": "doc_stale", "id": n.id})
                logger.info("[FRESHNESS] doc_stale: документ {} ({} дн.)", doc.id, age_days)
            except Exception as e:
                db.rollback()
                logger.warning("[FRESHNESS] документ {}: {}", doc.id, e)
    finally:
        db.close()


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(timezone="UTC", daemon=True)
    _scheduler.add_job(
        _refresh_web_sources_job,
        trigger=IntervalTrigger(minutes=30),
        id="refresh_web_sources",
        max_instances=1,
        coalesce=True,
    )
    # А7: контроль актуальности — раз в сутки + через 5 минут после старта
    _scheduler.add_job(
        check_documents_freshness_job,
        trigger=IntervalTrigger(hours=24),
        next_run_time=datetime.utcnow() + timedelta(minutes=5),
        id="documents_freshness",
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    logger.info("Планировщик запущен")


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
