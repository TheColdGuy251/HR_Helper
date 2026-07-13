from __future__ import annotations
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "HR Helper"
    debug: bool = False
    host: str = "0.0.0.0"
    port: int = 8000

    # Security
    secret_key: str = "change-me-in-production-please"
    session_max_age_sec: int = 60 * 60 * 24 * 14  # 14 days
    # Защита канала клиент↔сервер. За HTTPS-прокси включите session_https_only=True
    # (в .env) — cookie сессии будет ставиться только по HTTPS. same_site=lax защищает
    # от CSRF при переходах с чужих сайтов, не ломая обычную навигацию.
    session_https_only: bool = False
    session_same_site: str = "lax"
    # Заголовки безопасности (HSTS/CSP/anti-clickjacking/nosniff). HSTS отдаётся только
    # по HTTPS. Если строгий CSP что-то ломает — отключите security_csp в .env.
    security_headers: bool = True
    security_csp: bool = True
    hsts_max_age: int = 31536000  # 1 год
    # Web Push (системные уведомления на телефон/десктоп, даже когда вкладка закрыта).
    # Пусто → VAPID-ключи генерируются автоматически в db/vapid.json (стабильны между
    # перезапусками). Требует установленного пакета pywebpush (см. requirements.txt).
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:admin@localhost"

    # Paths
    base_dir: Path = BASE_DIR
    db_dir: Path = BASE_DIR / "db"
    db_file: Path = BASE_DIR / "db" / "hr_helper.db"
    docs_dir: Path = BASE_DIR / "docs"
    docs_local: Path = BASE_DIR / "docs" / "local"
    docs_web: Path = BASE_DIR / "docs" / "web"
    docs_templates: Path = BASE_DIR / "docs" / "templates"
    docs_generated: Path = BASE_DIR / "docs" / "generated"
    models_dir: Path = BASE_DIR / "models"
    logs_dir: Path = BASE_DIR / "logs"

    # LLM
    llm_model_path: str = str(BASE_DIR / "models" / "T-lite-it-2.1-Q4_K_M.gguf")
    llm_n_ctx: int = 16384  # окно контекста; KV-cache ~1.5 ГБ на 16k для 8B Q4
    llm_n_threads: int = 0
    llm_n_threads_batch: int = 0
    llm_n_batch: int = 1024
    llm_n_ubatch: int = 512
    llm_flash_attn: bool = False
    # GPU / CPU режим. llm_use_gpu=True выгружает слои модели на видеокарту — заметно
    # быстрее prefill и генерация. ТРЕБУЕТ llama-cpp-python, собранного с поддержкой
    # GPU (CUDA/Metal/Vulkan); обычная CPU-сборка флаг проигнорирует (останется CPU).
    # llm_n_gpu_layers — сколько слоёв на GPU: -1 = все, 0 = (при use_gpu) трактуется
    # как «все». При llm_use_gpu=False режим всегда чисто CPU (0 слоёв).
    llm_use_gpu: bool = False
    llm_n_gpu_layers: int = 0
    # Динамическая температура — своя для каждого типа запроса (см. pipeline.answer_stream):
    # llm_temperature — обычный чат без контекста; llm_answer_temperature — ответ ПО
    # ВЫДЕРЖКАМ (низкая → детерминизм, на пограничном контексте модель не «подбрасывает
    # монетку» между ответом и отказом); llm_smalltalk_temperature — неформальный
    # разговор (высокая → живой, разнообразный тон вместо канцелярита).
    llm_temperature: float = 0.3
    llm_answer_temperature: float = 0.1
    llm_smalltalk_temperature: float = 0.7
    llm_top_p: float = 0.9
    llm_max_tokens: int = 2048  # максимум токенов ответа (≈ 1500 слов на русском)
    llm_lazy_load: bool = True  # модель грузится при первом запросе
    llm_enabled: bool = True    # False => mock-ответы для тестов без модели

    # Кэш моделей FastEmbed. По умолчанию FastEmbed кладёт модели в %TEMP%/fastembed_cache,
    # который Windows и утилиты очистки Temp могут удалить — тогда при следующем старте
    # реранкер (~1.1ГБ) и эмбеддер качаются заново, а прерванная закачка оставляет битый
    # снапшот (нет config.json → реранкер молча падает в RRF). Держим кэш в проекте.
    fastembed_cache_dir: Path = BASE_DIR / "models" / "fastembed_cache"

    # Embeddings (см. services/embeddings/encoder.py — будут перебираться по списку).
    # mpnet-base (768d) точнее на русском, MiniLM-L12 (384d) — fallback.
    embed_model: str = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"
    # Число потоков ONNX-эмбеддера. 0 = АВТО: оставить одно ядро свободным, чтобы
    # индексация большого документа (тысячи чанков) не занимала весь CPU и не
    # «подвешивала» интерфейс/машину. Поставьте число ядер, если нужен максимум скорости.
    embed_threads: int = 0

    # Reranker. МУЛЬТИЯЗЫЧНЫЙ (корпус на русском); англоязычные (ms-marco) на русском
    # ранжируют мусорно. По замеру на eval: jina-v2-multilingual → answer 22/22 (100%)
    # против bge-base 21/22. ВНИМАНИЕ: ~1.1ГБ ONNX jina-v2 плохо качается с HF на части
    # каналов (встаёт на 256МБ). Если на свежей машине не скачается — fastembed бросит
    # ошибку и reranker откатится на BAAI/bge-reranker-base (см. reranker._load).
    # Ручная докачка: hf_hub_download(repo, "onnx/model.onnx") → скопировать в fastembed_cache.
    rerank_model: str = "jinaai/jina-reranker-v2-base-multilingual"
    rerank_top_n: int = 5  # сколько чанков уйдёт в LLM после реранкинга
    rerank_input_max: int = 30  # макс. кандидатов в кросс-энкодер (ограничение latency на CPU)
    rerank_rrf_keep: int = 3    # сколько топ-кандидатов RRF гарантированно сохранять (safety-net)

    # Qdrant
    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: str | None = None
    qdrant_collection: str = "hr_knowledge"

    # Retrieval
    retrieval_top_k: int = 20  # сколько кандидатов поднять до реранкера (dense+bm25)
    chunk_size: int = 600
    chunk_overlap: int = 100

    # Advanced RAG
    # HyDE по умолчанию ВЫКЛЮЧЕН: на сильном поиске (dense + лемматизир. BM25 + реранкер)
    # гипотетический текст уводит в сторону (замер на eval: recall 19→20, answer без потерь).
    rag_use_hyde: bool = False              # генерировать гипотетический ответ для коротких запросов
    rag_hyde_max_query_chars: int = 80
    rag_use_decomposition: bool = True      # разбивать сложные запросы на подвопросы
    rag_decomposition_max: int = 3
    rag_use_self_check: bool = True         # фоновая проверка фактов в ответе
    rag_use_topic_classify: bool = True     # классификация запроса по теме для boost тегов
    rag_memory_after_messages: int = 6      # с какого числа сообщений включается сводка диалога
    rag_memory_recent_keep: int = 2         # сколько последних реплик пары (user+assistant) держать «как есть»

    # Контекстная intent-классификация (services/rag/intent_classifier.py):
    # семантический уровень (эмбеддинги, прототипы классов) + LLM для пограничных
    # случаев. Порог — мин. близость к лучшему классу; маржа — отрыв от второго
    # (меньше маржа → классы спорят → решает LLM). None-вердикт откатывает
    # обработку к прежним регэксп-гейтам, так что распознавание только расширяется.
    intent_semantic_threshold: float = 0.50
    intent_semantic_margin: float = 0.05
    intent_use_llm: bool = True

    # Semantic-router: эмбеддинговый pre-filter поверх энкодера. Ловит «структурные»
    # запросы без явных триггер-слов (перефразировки). По умолчанию выключен — на CPU
    # ложное срабатывание = лишний вызов планировщика. Включить для большей полноты.
    rag_use_semantic_router: bool = True
    rag_router_threshold: float = 0.55      # мин. косинус-близость к структурным примерам

    # GBNF-грамматика планировщика: жёсткая гарантия схемы. По умолчанию OFF —
    # нативный парсер GBNF в некоторых сборках llama.cpp нестабилен (native crash).
    # Мягкий режим (response_format=json_object) + валидация в planner работают надёжно.
    # Включайте, только если ваша сборка корректно парсит GBNF.
    rag_planner_use_grammar: bool = True

    # Конвертация старых форматов Office (.doc/.xls/.rtf/.odt → docx/xlsx) через LibreOffice.
    # Путь к soffice/soffice.exe, если он не в PATH (Windows: …/LibreOffice/program/soffice.exe).
    soffice_cmd: str | None = None

    # OCR
    tesseract_cmd: str | None = None  # путь к tesseract.exe на Windows если не в PATH
    ocr_languages: str = "rus+eng"
    ocr_min_chars_per_page: int = 80  # ниже — считаем сканом

    # Web scraping. Реалистичный браузерный User-Agent: многие сайты (Wikipedia,
    # новостные порталы, CDN) отдают 403 на «ботовые» UA. С обычным браузерным
    # заголовком парсер читает подавляющее большинство страниц.
    web_user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
    web_request_timeout: int = 30


settings = Settings()


# FastEmbed 0.8+ у mpnet перешёл с CLS на mean pooling и печатает об этом UserWarning
# при каждом старте. В нашем случае это безопасно: коллекция Qdrant уже построена этой
# же версией (проверено — cos(stored, re-encoded)=1.0), рассинхрона query/passage нет,
# переиндексация не нужна. Глушим шум, чтобы предупреждение не пугало в логах.
import warnings as _warnings

_warnings.filterwarnings(
    "ignore",
    message=r".*now uses mean pooling instead of CLS embedding.*",
    category=UserWarning,
)


def ensure_dirs() -> None:
    for p in (
        settings.db_dir,
        settings.docs_dir,
        settings.docs_local,
        settings.docs_web,
        settings.docs_templates,
        settings.docs_generated,
        settings.models_dir,
        settings.fastembed_cache_dir,
        settings.logs_dir,
    ):
        p.mkdir(parents=True, exist_ok=True)
