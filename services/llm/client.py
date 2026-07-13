from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Iterator

from config import settings
from utils.logger import logger


def _register_cuda_dll_dirs() -> None:
    """Добавляет каталоги CUDA-runtime (pip-пакеты nvidia-cuda-runtime-cu12 /
    nvidia-cublas-cu12) в путь поиска DLL, чтобы bundled ggml-cuda.dll нашёл
    cudart/cublas. Только Windows, вызывается лишь в GPU-режиме."""
    if os.name != "nt":
        return
    try:
        import nvidia

        added = 0
        for base in map(Path, nvidia.__path__):
            for binp in base.glob("*/bin"):
                if binp.is_dir():
                    os.add_dll_directory(str(binp))
                    # Главное: llama-cpp грузит DLL с winmode=RTLD_GLOBAL, при котором
                    # add_dll_directory НЕ используется для зависимостей, а PATH — да.
                    os.environ["PATH"] = str(binp) + os.pathsep + os.environ.get("PATH", "")
                    added += 1
        if added:
            logger.info("CUDA DLL-каталоги зарегистрированы ({})", added)
    except ImportError:
        # Пакеты nvidia-*-cu12 не установлены. Для CPU-сборки это норма (no-op).
        # Для CUDA-сборки последующий импорт llama_cpp упадёт с понятной ошибкой.
        logger.debug("nvidia-*-cu12 не установлены — пропускаю регистрацию CUDA DLL")
    except Exception as e:
        logger.warning("Не удалось зарегистрировать CUDA DLL-каталоги: {}", e)


class LLMClient:
    """Тонкая обёртка над llama-cpp-python. Lazy-load: модель грузится при первом вызове.

    ВНИМАНИЕ: llama-cpp-python НЕ thread-safe. Параллельные вызовы в один и тот же
    Llama-instance приводят к access-violation в нативном коде. Все публичные методы
    инференса берут общий лок — это сериализует запросы (один LLM-вызов за раз),
    при этом FastAPI/SSE остаётся отзывчивым (стримим из-под локa, освобождаем после).
    """

    def __init__(self):
        import threading

        self._llm = None
        self._model_path = Path(settings.llm_model_path)
        self._loaded = False
        self._available = settings.llm_enabled
        self._lock = threading.Lock()
        # Если нативный парсер GBNF этого билда llama.cpp отвергает грамматику —
        # отключаем её на сессию (избегаем повторных native access-violation).
        self._grammar_disabled = False

    def _ensure_loaded(self) -> bool:
        if self._loaded:
            return self._llm is not None
        self._loaded = True

        if not self._available:
            logger.warning("LLM отключена (LLM_ENABLED=false). Будет mock-ответ.")
            return False

        if not self._model_path.exists():
            logger.warning(
                "Файл модели не найден: {}. Будет использован mock-ответ. "
                "Скачайте GGUF-модель и положите в models/.",
                self._model_path,
            )
            return False

        try:
            # ВАЖНО: у CUDA-сборки llama-cpp-python bundled ggml-cuda.dll грузится
            # ещё при ИМПОРТЕ — и требует cudart/cublas даже в CPU-режиме. Поэтому
            # пути CUDA-runtime регистрируем ВСЕГДА (для CPU-сборки — это no-op).
            _register_cuda_dll_dirs()

            from llama_cpp import Llama

            logical = os.cpu_count() or 4
            # Авто-определение оптимума: physical_cores - 1 (запас на ОС/FastAPI).
            # С psutil — точное число physical cores; без — эвристика logical // 2 (предполагаем HT).
            try:
                import psutil
                physical = psutil.cpu_count(logical=False) or logical
            except Exception:
                physical = max(1, logical // 2)
            # Если physical == logical (HT отключен/нет), оставим один свободный поток;
            # на CPU с HT обычно оптимально physical, без вычитания.
            if physical >= logical:
                auto_threads = max(1, physical - 1)
            else:
                auto_threads = physical
            n_threads = settings.llm_n_threads or auto_threads
            n_threads_batch = settings.llm_n_threads_batch or n_threads
            logger.info(
                "CPU: logical={}, physical={}, auto_threads={}",
                logical, physical, auto_threads,
            )

            # GPU/CPU режим: сколько слоёв выгрузить на видеокарту.
            if settings.llm_use_gpu:
                n_gpu_layers = settings.llm_n_gpu_layers if settings.llm_n_gpu_layers != 0 else -1
            else:
                n_gpu_layers = 0
            logger.info(
                "Режим LLM: {} (n_gpu_layers={})",
                "GPU" if n_gpu_layers != 0 else "CPU",
                n_gpu_layers,
            )
            if n_gpu_layers != 0:
                try:
                    from llama_cpp import llama_supports_gpu_offload

                    if not llama_supports_gpu_offload():
                        logger.warning(
                            "llm_use_gpu=True, но текущая сборка llama-cpp-python без "
                            "GPU-поддержки — модель пойдёт на CPU. Переустановите пакет "
                            "с CUDA: CMAKE_ARGS='-DGGML_CUDA=on' pip install "
                            "llama-cpp-python --force-reinstall --no-cache-dir."
                        )
                except Exception:
                    pass  # старые версии без этой функции — пропускаем проверку

            logger.info(
                "Загружаю LLM: {} | n_threads={}, n_threads_batch={}, n_batch={}, n_ubatch={}, n_ctx={}, flash_attn={}",
                self._model_path.name,
                n_threads,
                n_threads_batch,
                settings.llm_n_batch,
                settings.llm_n_ubatch,
                settings.llm_n_ctx,
                settings.llm_flash_attn,
            )

            llama_kwargs = dict(
                model_path=str(self._model_path),
                n_ctx=settings.llm_n_ctx,
                n_threads=n_threads,
                n_threads_batch=n_threads_batch,
                n_batch=settings.llm_n_batch,
                n_ubatch=settings.llm_n_ubatch,
                n_gpu_layers=n_gpu_layers,
                use_mmap=True,
                use_mlock=False,
                verbose=False,
                chat_format="chatml",
            )
            # flash_attn появился в свежих llama-cpp-python; передаём аккуратно
            try:
                self._llm = Llama(**llama_kwargs, flash_attn=settings.llm_flash_attn)
            except TypeError:
                self._llm = Llama(**llama_kwargs)

            # Микро-инференс на 1 токен — прогрев backend (без него первый
            # реальный запрос платит за компиляцию операций).
            try:
                self._llm.create_completion(prompt="ok", max_tokens=1, temperature=0.0)
            except Exception as e:
                logger.warning("LLM warm-up inference не удался: {}", e)

            logger.info("LLM готова к работе")
            return True
        except Exception as e:
            logger.error("Не удалось загрузить LLM: {}", e)
            self._llm = None
            return False

    def is_ready(self) -> bool:
        return self._ensure_loaded()

    def chat_stream(
        self,
        system: str,
        user: str,
        history: list[dict] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> Iterator[str]:
        messages: list[dict] = [{"role": "system", "content": system}]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": user})

        # Оценка длины промпта (для логов)
        prompt_chars = sum(len(m.get("content", "")) for m in messages)
        approx_prompt_tokens = prompt_chars // 4
        logger.info(
            "[LLM] start: messages={}, ~prompt_tokens={}, max_tokens={}",
            len(messages),
            approx_prompt_tokens,
            max_tokens or settings.llm_max_tokens,
        )

        # Ставим в очередь на LLM. Лок отпускается, когда генератор полностью
        # отработан или закрыт сборщиком мусора / явным .close().
        waited_for_lock = self._lock.acquire(blocking=False)
        if not waited_for_lock:
            logger.info("[LLM] busy, ожидание в очереди…")
            self._lock.acquire()
        try:
            ready = self._ensure_loaded()
            if not ready:
                yield from self._mock_stream(user)
                return

            from time import perf_counter

            t_start = perf_counter()
            t_first = None
            chunk_count = 0
            try:
                stream = self._llm.create_chat_completion(
                    messages=messages,
                    temperature=temperature if temperature is not None else settings.llm_temperature,
                    top_p=settings.llm_top_p,
                    max_tokens=max_tokens or settings.llm_max_tokens,
                    stream=True,
                )
                for chunk in stream:
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    text = delta.get("content")
                    if text:
                        if t_first is None:
                            t_first = perf_counter()
                            logger.info(
                                "[LLM] TTFT (prefill) = {:.2f}s on ~{} prompt tokens",
                                t_first - t_start,
                                approx_prompt_tokens,
                            )
                        chunk_count += 1
                        yield text
            except Exception as e:
                logger.error("Ошибка стрима LLM: {}", e)
                yield f"\n[Ошибка генерации: {e}]"
            finally:
                t_end = perf_counter()
                total = t_end - t_start
                decode = t_end - (t_first or t_end)
                tps = chunk_count / decode if decode > 0 else 0.0
                logger.info(
                    "[LLM] done: total={:.2f}s, decode={:.2f}s, chunks={}, ~speed={:.1f} t/s",
                    total,
                    decode,
                    chunk_count,
                    tps,
                )
        finally:
            self._lock.release()

    def generate_text(
        self,
        system: str,
        user: str,
        max_tokens: int = 200,
        temperature: float = 0.0,
    ) -> str:
        """Синхронная (не-стримовая) короткая генерация — для HyDE, decompose, summary."""
        with self._lock:
            if not self._ensure_loaded():
                return ""
            try:
                resp = self._llm.create_chat_completion(
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    temperature=temperature,
                    top_p=settings.llm_top_p,
                    max_tokens=max_tokens,
                )
                return (resp["choices"][0]["message"]["content"] or "").strip()
            except Exception as e:
                logger.warning("generate_text failed: {}", e)
                return ""

    def generate_json(
        self, system: str, user: str, schema_hint: str, grammar=None
    ) -> dict:
        """Структурированная генерация JSON.

        Если передан `grammar` (скомпилированный LlamaGrammar) — выход жёстко
        ограничивается грамматикой (гарантия валидной схемы). Иначе — мягкий
        режим response_format=json_object + json.loads.
        """
        prompt_user = f"{user}\n\nСхема ответа (строго JSON):\n{schema_hint}"
        with self._lock:
            if not self._ensure_loaded():
                return {"_mock": True, "_note": "LLM недоступна, возвращён пустой объект"}
            base = dict(
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt_user},
                ],
                temperature=0.0,
                max_tokens=settings.llm_max_tokens,
            )
            # 1) Жёсткий режим через грамматику — если она ещё не забракована движком.
            if grammar is not None and not self._grammar_disabled:
                try:
                    resp = self._llm.create_chat_completion(**base, grammar=grammar)
                    return json.loads(resp["choices"][0]["message"]["content"])
                except Exception as e:
                    # Нативный парсер GBNF отверг грамматику (или иная ошибка) —
                    # отключаем на сессию и падаем в мягкий json_object, без повторов.
                    logger.error("Грамматика отклонена движком, отключаю на сессию: {}", e)
                    self._grammar_disabled = True
            # 2) Мягкий режим: response_format=json_object + json.loads.
            try:
                resp = self._llm.create_chat_completion(
                    **base, response_format={"type": "json_object"}
                )
                return json.loads(resp["choices"][0]["message"]["content"])
            except Exception as e:
                logger.error("Не удалось разобрать JSON-ответ LLM: {}", e)
                return {}

    @staticmethod
    def _mock_stream(user_message: str) -> Iterator[str]:
        text = (
            "Я HR-ассистент в режиме без модели (LLM не загружена).\n"
            f"Получен запрос: «{user_message}».\n"
            "Чтобы получить настоящие ответы — добавьте файл модели GGUF в каталог models/ "
            "и укажите путь в LLM_MODEL_PATH."
        )
        for ch in text:
            yield ch


@lru_cache(maxsize=1)
def get_llm() -> LLMClient:
    return LLMClient()
