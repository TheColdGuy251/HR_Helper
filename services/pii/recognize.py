"""Распознавание ФИО + даты рождения из текста загруженного документа.
Сначала пробуем regex по типичным шаблонам, потом — LLM для надёжности."""
from __future__ import annotations

import json
import re
from datetime import date
from typing import Any

from services.llm import get_llm
from utils.logger import logger


_SYSTEM_PROMPT_PII_RECOGNIZE = (
    "Вы извлекаете персональные данные сотрудника из HR-документа на русском. "
    "Верните строго JSON: "
    '{"surname":"...", "name":"...", "patronymic":"..."|null, '
    '"birth_date":"DD.MM.YYYY"|null}. '
    "Если каких-то полей нет — null. Никакого текста вне JSON."
)


_DATE_RE = re.compile(r"\b(\d{2})\.(\d{2})\.(\d{4})\b")
_FIO_RE = re.compile(
    r"\b([А-ЯЁ][а-яё]+)\s+([А-ЯЁ][а-яё]+)(?:\s+([А-ЯЁ][а-яё]+))?\b"
)


def _quick_pre_parse(text: str) -> dict[str, Any]:
    """Лёгкая попытка вытащить очевидное regex'ом."""
    out: dict[str, Any] = {}
    m = _FIO_RE.search(text)
    if m:
        out["surname"] = m.group(1)
        out["name"] = m.group(2)
        out["patronymic"] = m.group(3)
    # Поиск даты рождения по контекстным маркерам
    for marker in (
        r"дата\s+рождения[:\s]+(\d{2})\.(\d{2})\.(\d{4})",
        r"родил[аи]сь[:\s]+(\d{2})\.(\d{2})\.(\d{4})",
        r"г\.р\.\s*(\d{2})\.(\d{2})\.(\d{4})",
    ):
        m = re.search(marker, text, re.IGNORECASE)
        if m:
            try:
                out["birth_date"] = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            except ValueError:
                pass
            break
    return out


def recognize_person(text: str) -> dict[str, Any]:
    """Возвращает dict {surname, name, patronymic, birth_date(date|None)}.
    Любое поле может быть None — UI даст пользователю исправить.
    """
    if not text or not text.strip():
        return {"surname": None, "name": None, "patronymic": None, "birth_date": None}

    pre = _quick_pre_parse(text[:4000])

    llm = get_llm()
    sample = text[:3500]  # для LLM не нужен полный текст
    try:
        raw = llm.generate_text(_SYSTEM_PROMPT_PII_RECOGNIZE, sample, max_tokens=160, temperature=0.0)
        m = re.search(r"\{.*?\}", raw, re.DOTALL)
        data: dict[str, Any] = json.loads(m.group(0)) if m else {}
    except Exception as e:
        logger.warning("recognize_person LLM failed: {}", e)
        data = {}

    surname = data.get("surname") or pre.get("surname")
    name = data.get("name") or pre.get("name")
    patronymic = data.get("patronymic") or pre.get("patronymic")

    bd: date | None = pre.get("birth_date")
    raw_bd = (data.get("birth_date") or "").strip() if isinstance(data.get("birth_date"), str) else ""
    if not bd and raw_bd:
        m = _DATE_RE.search(raw_bd)
        if m:
            try:
                bd = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            except ValueError:
                bd = None

    def _clean(v):
        if not v: return None
        s = str(v).strip()
        return s or None

    return {
        "surname": _clean(surname),
        "name": _clean(name),
        "patronymic": _clean(patronymic),
        "birth_date": bd,
    }
