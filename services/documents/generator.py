from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from docxtpl import DocxTemplate
from sqlalchemy.orm import Session

from config import settings
from data.doc_templates import DocTemplate
from data.my_documents import MyDocuments
from data.users import User
from services.documents.autofill import analyze as auto_analyze
from services.documents.autofill import autofill, has_jinja_placeholders
from services.llm import get_llm
from services.llm.prompts import SYSTEM_PROMPT_EXTRACT
from utils.logger import logger


def auto_field_schema(path: str) -> list[dict]:
    """Авто-определённая схема полей бланка без переменных — для регистрации шаблона
    (Фаза 2) и уточняющих вопросов. Возвращает список {name,label,type,required}."""
    schema, _ = auto_analyze(path)
    return schema


def template_display_path(tpl: DocTemplate) -> Path:
    """Путь к версии шаблона ДЛЯ ПРОСМОТРА/СКАЧИВАНИЯ. Для бланка .docx без
    {{переменных}} — версия с подставленными НАЗВАНИЯМИ авто-полей (кэшируется в
    docs/templates/.previews). Для остального (jinja-docx, pdf) — оригинал."""
    src = _resolve_template_path(tpl)
    if src.suffix.lower() != ".docx" or has_jinja_placeholders(src):
        return src
    cache_dir = settings.docs_templates / ".previews"
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{tpl.id}.docx"
    try:
        if (not out.exists()) or out.stat().st_mtime < src.stat().st_mtime:
            from services.documents.autofill import render_field_preview

            render_field_preview(src, out)
    except Exception as e:
        logger.warning("preview рендер шаблона {} не удался: {}", tpl.id, e)
        return src
    return out


def list_templates(db: Session) -> list[DocTemplate]:
    return db.query(DocTemplate).filter(DocTemplate.is_enabled == True).all()  # noqa: E712


def _resolve_template_path(tpl: DocTemplate) -> Path:
    p = Path(tpl.file_path)
    if not p.is_absolute():
        p = settings.docs_templates / p
    if not p.exists():
        raise FileNotFoundError(f"Шаблон не найден: {p}")
    return p


def _safe_filename(s: str) -> str:
    bad = '<>:"/\\|?*'
    out = "".join("_" if ch in bad else ch for ch in s).strip()
    return out[:120] or "document"


def render_template(tpl: DocTemplate, context: dict[str, Any]) -> Path:
    src = _resolve_template_path(tpl)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_name = f"{_safe_filename(tpl.key)}_{ts}.docx"
    out_path = Path(settings.docs_generated) / out_name
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if has_jinja_placeholders(src):
        # Обычный путь: шаблон с {{ переменными }} (docxtpl / Jinja2).
        doc = DocxTemplate(str(src))
        # None → пустая строка: Jinja печатает буквальное «None», а в бланке нужно
        # пустое место для незаполненных (в т.ч. опциональных) полей.
        safe_context = {k: ("" if v is None else v) for k, v in (context or {}).items()}
        doc.render(safe_context)
        doc.save(str(out_path))
    else:
        # Бланк БЕЗ переменных: авто-определяем поля и подставляем значения прямо
        # в пропуски-«пустографки», сохраняя шрифт/стиль места (см. autofill).
        autofill(src, context or {}, out_path)
    return out_path


def extract_fields_with_llm(
    template: DocTemplate,
    user_text: str,
    extra_context: str | None = None,
) -> dict[str, Any]:
    """Просит LLM извлечь значения полей шаблона из пользовательского описания."""
    schema = template.fields_schema or []
    schema_hint = json.dumps({f["name"]: f.get("type", "string") for f in schema}, ensure_ascii=False)

    extraction_prompt = template.extraction_prompt or (
        "Извлеките значения полей для шаблона документа из приведённого текста."
    )

    user = f"{extraction_prompt}\n\nТекст:\n{user_text}"
    if extra_context:
        user += f"\n\nДополнительный контекст:\n{extra_context}"

    llm = get_llm()
    return llm.generate_json(SYSTEM_PROMPT_EXTRACT, user, schema_hint=schema_hint)


def generate_document(
    db: Session,
    user: User,
    template_key: str,
    fields: dict[str, Any],
    title: str | None = None,
) -> MyDocuments:
    tpl = db.query(DocTemplate).filter(DocTemplate.key == template_key).first()
    if not tpl:
        raise ValueError(f"Шаблон '{template_key}' не найден")

    try:
        out_path = render_template(tpl, fields)
    except Exception as e:
        logger.error("Ошибка рендера шаблона {}: {}", template_key, e)
        raise

    doc = MyDocuments(
        user_id=user.id,
        title=title or tpl.title,
        template_key=template_key,
        file_path=str(out_path),
        progress=100,
        status="ready",
        fields=fields,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc
