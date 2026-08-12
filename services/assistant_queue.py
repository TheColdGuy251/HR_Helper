"""Справедливая (FIFO) очередь запросов к ИИ-ассистенту.

Зачем это нужно
---------------
Раньше каждый запрос к ассистенту (routes/chat.py, routes/messenger.py) сразу
поднимал отдельный поток без всякого ограничения. При наплыве пользователей
это давало: десятки RAG-пайплайнов, конкурирующих за единственный лок LLM;
неограниченный рост памяти/числа потоков; отсутствие честного порядка и обратной
связи о позиции. Для одиночной инсталляции это работало, для многопользовательской —
нет.

Что делает очередь
------------------
* Ограничивает число ОДНОВРЕМЕННО обрабатываемых запросов до
  ``settings.assistant_max_concurrent`` (по умолчанию 2, настраивается).
* Обслуживает ожидающих строго в порядке поступления (FIFO — «справедливо»).
* Пока запрос ждёт, сообщает ему его позицию (колбэк ``on_position``); момент
  реального старта — колбэк ``on_start``.
* При переполнении очереди ожидания (``settings.assistant_queue_maxsize``) или
  превышении лимита на пользователя (``settings.assistant_max_per_user``) новый
  запрос отклоняется с понятным текстом (backpressure/анти-флуд).

Важная оговорка про параллелизм
-------------------------------
Настоящая генерация токенов ВСЁ РАВНО сериализуется локом внутри ``LLMClient``
(``services/llm/client.py``): llama-cpp не потокобезопасен, один инстанс модели
не считает два запроса сразу. Поэтому ``assistant_max_concurrent`` — это
admission control для ПАЙПЛАЙНА: при N>1 этапы RAG (поиск, реранк) разных
запросов идут параллельно, а модель по-прежнему обрабатывает по одному вызову.
Лимит остаётся полезным (перекрытие не-LLM стадий + жёсткий потолок нагрузки), а
лок модели остаётся гарантией безопасности. Если позже появится пул моделей или
continuous batching — очередь уже готова это использовать.

Модель процесса — один воркер uvicorn (см. app.py и services/notify.py): очередь
живёт в памяти процесса и общая для всех запросов. При запуске с ``--workers`` у
каждого процесса была бы своя очередь (как и свой лок LLM).
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Callable

from config import settings
from utils.logger import logger

# Тип колбэка позиции: (позиция_в_очереди, всего_ожидающих) -> None.
PositionCB = Callable[[int, int], None]


class QueueRejected(Exception):
    """Запрос не принят в очередь (переполнение или лимит на пользователя).

    ``user_message`` — готовый к показу пользователю текст; ``reason`` —
    машиночитаемая причина (``queue_full`` | ``per_user_limit``)."""

    def __init__(self, user_message: str, reason: str):
        super().__init__(user_message)
        self.user_message = user_message
        self.reason = reason


@dataclass
class _Job:
    ticket: int
    user_id: int | None
    fn: Callable[..., Any]
    args: tuple
    kwargs: dict
    on_position: PositionCB | None
    on_start: Callable[[], None] | None
    started: bool = field(default=False)


class AssistantQueue:
    """Потокобезопасный диспетчер задач с честным порядком и лимитом параллелизма.

    Реализация: на каждую задачу поднимается лёгкий поток-носитель, который
    паркуется на условной переменной, пока не выполнится условие
    «есть свободный слот И я — самый старый ожидающий». Это даёт строгий FIFO без
    отдельного диспетчер-потока и позволяет менять лимит параллелизма на лету.
    """

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._waiting: list[_Job] = []  # отсортирован по ticket (FIFO)
        self._active = 0
        self._counter = 0

    # --- Лимиты читаем из settings ДИНАМИЧЕСКИ, чтобы правки применялись без
    #     перезапуска процесса (напр. если админ-панель меняет settings в памяти). ---
    @property
    def max_concurrent(self) -> int:
        return max(1, int(getattr(settings, "assistant_max_concurrent", 2) or 2))

    @property
    def max_waiting(self) -> int:
        return max(1, int(getattr(settings, "assistant_queue_maxsize", 50) or 50))

    @property
    def max_per_user(self) -> int:
        return max(1, int(getattr(settings, "assistant_max_per_user", 3) or 3))

    # ------------------------------------------------------------------ submit
    def submit(
        self,
        fn: Callable[..., Any],
        args: tuple = (),
        kwargs: dict | None = None,
        *,
        user_id: int | None = None,
        on_position: PositionCB | None = None,
        on_start: Callable[[], None] | None = None,
    ) -> None:
        """Ставит задачу в очередь. Бросает ``QueueRejected`` при переполнении
        очереди ожидания или превышении лимита запросов на пользователя.

        ``on_position(pos, total)`` вызывается, пока задача ждёт (и при каждом
        изменении позиции); ``on_start()`` — один раз, когда задача пошла в работу.
        Оба колбэка должны быть быстрыми и неблокирующими (обычно просто ставят
        событие/публикуют уведомление)."""
        kwargs = kwargs or {}
        with self._cv:
            if len(self._waiting) >= self.max_waiting:
                raise QueueRejected(
                    "Сервис ассистента сейчас перегружен — слишком много запросов "
                    "в очереди. Пожалуйста, попробуйте через минуту.",
                    reason="queue_full",
                )
            if user_id is not None:
                same_user = sum(1 for j in self._waiting if j.user_id == user_id)
                if same_user >= self.max_per_user:
                    raise QueueRejected(
                        "У вас уже несколько запросов в обработке. Дождитесь ответа "
                        "на предыдущие, прежде чем отправлять новый.",
                        reason="per_user_limit",
                    )
            self._counter += 1
            job = _Job(
                ticket=self._counter,
                user_id=user_id,
                fn=fn,
                args=tuple(args),
                kwargs=kwargs,
                on_position=on_position,
                on_start=on_start,
            )
            self._waiting.append(job)
            logger.info(
                "[QUEUE] +ticket={} user={} waiting={} active={} max_concurrent={}",
                job.ticket, user_id, len(self._waiting), self._active, self.max_concurrent,
            )
            updates = self._positions_locked()
        self._fire_positions(updates)
        threading.Thread(
            target=self._run, args=(job,), name=f"assistant-job-{job.ticket}", daemon=True
        ).start()

    # --------------------------------------------------------------- worker
    def _run(self, job: _Job) -> None:
        with self._cv:
            # Условие старта: свободен слот И мы — самый старый ожидающий (FIFO).
            while not (
                self._active < self.max_concurrent
                and self._waiting
                and self._waiting[0].ticket == job.ticket
            ):
                self._cv.wait()
            self._waiting.pop(0)
            self._active += 1
            job.started = True
            logger.info(
                "[QUEUE] start ticket={} waiting={} active={}",
                job.ticket, len(self._waiting), self._active,
            )
            updates = self._positions_locked()
        # Колбэки — вне лока: старт этой задачи + сдвиг позиций у остальных.
        self._fire_positions(updates)
        if job.on_start:
            try:
                job.on_start()
            except Exception as e:  # noqa: BLE001
                logger.debug("[QUEUE] on_start ticket={} failed: {}", job.ticket, e)
        try:
            job.fn(*job.args, **job.kwargs)
        except Exception as e:  # noqa: BLE001
            # Ошибку самой задачи здесь только логируем — за отдачу текста
            # пользователю отвечает сама fn (в chat/messenger).
            logger.exception("[QUEUE] job ticket={} упала: {}", job.ticket, e)
        finally:
            with self._cv:
                self._active -= 1
                logger.info(
                    "[QUEUE] done ticket={} waiting={} active={}",
                    job.ticket, len(self._waiting), self._active,
                )
                self._cv.notify_all()  # разбудить ожидающих — освободился слот
                updates = self._positions_locked()
            self._fire_positions(updates)

    # --------------------------------------------------------------- helpers
    def _positions_locked(self) -> list[tuple[PositionCB, int, int]]:
        """Считает «человеческую» позицию каждого ожидающего под локом и возвращает
        список колбэков к вызову (сами вызовы — вне лока, чтобы не держать cv).

        Первые ``free_slots`` ожидающих будут подхвачены прямо сейчас (их
        поток-носитель вот-вот займёт слот) — им позицию НЕ шлём, чтобы не
        мигал «Вы 1-й в очереди» в обычном случае без нагрузки. Остальным
        позиция = номер в хвосте, начиная с 1."""
        free_slots = max(0, self.max_concurrent - self._active)
        waiting_tail = self._waiting[free_slots:]
        total = len(waiting_tail)
        out: list[tuple[PositionCB, int, int]] = []
        for idx, j in enumerate(waiting_tail, start=1):
            if j.on_position is not None:
                out.append((j.on_position, idx, total))
        return out

    @staticmethod
    def _fire_positions(updates: list[tuple[PositionCB, int, int]]) -> None:
        for cb, pos, total in updates:
            try:
                cb(pos, total)
            except Exception as e:  # noqa: BLE001
                logger.debug("[QUEUE] on_position failed: {}", e)

    # ---------------------------------------------------------------- stats
    def stats(self) -> dict:
        """Снимок состояния очереди (для мониторинга / админ-панели)."""
        with self._cv:
            return {
                "active": self._active,
                "waiting": len(self._waiting),
                "max_concurrent": self.max_concurrent,
                "max_waiting": self.max_waiting,
                "max_per_user": self.max_per_user,
            }


_queue: AssistantQueue | None = None
_queue_lock = threading.Lock()


def get_assistant_queue() -> AssistantQueue:
    """Ленивый синглтон очереди на процесс."""
    global _queue
    if _queue is None:
        with _queue_lock:
            if _queue is None:
                _queue = AssistantQueue()
    return _queue
