"""Распознавание HR-команд: «нанять Иванова», «оформить отпуск Петровой».
   Возвращает шаблон документа и извлечённые поля."""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from data.doc_templates import DocTemplate
from services.llm import get_llm
from services.llm.prompts import SYSTEM_PROMPT_EXTRACT, SYSTEM_PROMPT_INTENT
from utils.logger import logger


def detect_template(db: Session, query: str) -> DocTemplate | None:
    """LLM-классификация: соответствует ли запрос намерению создать какой-либо
    зарегистрированный шаблон. Возвращает шаблон или None.
    """
    templates: list[DocTemplate] = (
        db.query(DocTemplate).filter(DocTemplate.is_enabled == True).all()  # noqa: E712
    )
    if not templates:
        return None

    items = "\n".join(
        f'- key="{t.key}": {t.title}'
        + (f" — {t.description}" if t.description else "")
        for t in templates
    )

    user = (
        f"Доступные шаблоны HR-документов:\n{items}\n\n"
        f"Запрос пользователя:\n{query.strip()}\n\n"
        "Верни JSON по схеме: "
        '{"action":"generate|ask","template_key":"<один из ключей выше или null>"}.'
    )

    llm = get_llm()
    data = llm.generate_json(SYSTEM_PROMPT_INTENT, user, schema_hint="action, template_key")
    if not isinstance(data, dict):
        return None
    if data.get("action") != "generate":
        return None
    key = (data.get("template_key") or "").strip()
    if not key:
        return None
    tpl = next((t for t in templates if t.key == key), None)
    if tpl:
        logger.info("[INTENT] generate document → template='{}' ({})", tpl.key, tpl.title)
    else:
        logger.warning("[INTENT] template_key='{}' не найден среди шаблонов", key)
    return tpl


def extract_fields(
    query: str, template: DocTemplate, context: str | None = None
) -> dict[str, Any]:
    """Просит LLM извлечь значения полей шаблона из произвольного русского текста.

    `context` — необязательный текст предыдущих реплик диалога. Нужен, чтобы
    доизвлечь поля, если пользователь досказывает недостающие сведения отдельным
    сообщением («оклад 50000») в ответ на просьбу уточнить.
    """
    schema = template.fields_schema or []
    if not schema:
        return {}

    # Подсказываем модели тип поля — чтобы в числовые поля не попадал текст.
    def _desc(f: dict) -> str:
        label = f.get("label", f["name"])
        hint = " (число)" if _is_numeric_field(f) else ""
        return f'- {f["name"]}: {label}{hint}'

    fields_desc = "\n".join(_desc(f) for f in schema)
    context_block = (
        f"Контекст предыдущих сообщений (используйте, если в запросе не хватает данных):\n{context.strip()}\n\n"
        if context and context.strip()
        else ""
    )
    user = (
        f"Извлеките значения полей из запроса HR-специалиста.\n"
        f"Поля:\n{fields_desc}\n\n"
        f"{context_block}"
        f"Запрос: {query.strip()}\n\n"
        "Верните строго JSON. Если значение неизвестно — null. "
        "В числовые поля (помечены «(число)») кладите ТОЛЬКО число без слов и единиц; "
        "если в запросе для такого поля названо не число — верните для него null. "
        "Не добавляйте полей, которых нет в списке."
    )
    schema_hint = json.dumps(
        {f["name"]: f.get("type", "string") for f in schema}, ensure_ascii=False
    )
    llm = get_llm()
    data = llm.generate_json(SYSTEM_PROMPT_EXTRACT, user, schema_hint=schema_hint)
    if not isinstance(data, dict):
        return {}

    # Оставляем только известные поля
    known = {f["name"] for f in schema}
    return {k: v for k, v in data.items() if k in known}


_TODAY_LIKE = {
    "date", "date_today", "today",
    "date_start", "start_date", "дата", "дата_начала",
}


def fill_defaults(fields: dict[str, Any], template: DocTemplate) -> dict[str, Any]:
    """Подставляет умолчания (например, сегодняшнюю дату для пустых date-полей)."""
    today_str = datetime.now().strftime("%d.%m.%Y")
    out = dict(fields or {})
    for f in (template.fields_schema or []):
        name = f.get("name", "")
        if (out.get(name) in (None, "")) and name.lower() in _TODAY_LIKE:
            out[name] = today_str
    return out


def summarize_for_title(template: DocTemplate, fields: dict[str, Any]) -> str:
    """Удобное имя для отображения в чате и MyDocuments."""
    surname = fields.get("surname") or fields.get("фамилия")
    name = fields.get("name") or fields.get("имя")
    patronymic = fields.get("patronymic") or fields.get("отчество")
    person_bits = " ".join(p for p in (surname, name, patronymic) if p)
    if person_bits:
        return f"{template.title} — {person_bits}"
    return template.title


_TRIGGER_WORDS = (
    # Приём на работу: «нанять/найми/наняла/нанимаем», «приём/принять/прими»
    r"наним", r"нанят", r"нанял", r"нанима", r"найм", r"найми",
    r"приня", r"прими", r"прин[еия]", r"приём", r"прием",
    # Увольнение
    r"уволь", r"уволи", r"уволен", r"увольн",
    # Отпуск, переводы
    r"отпуск", r"перевод", r"перевест",
    # Прямые команды на генерацию документов
    r"оформ", r"состав", r"созда", r"сгенер", r"подготов", r"выдай",
    r"сделай.*(приказ|документ|заявлен)", r"подпиши",
    # Названия документов
    r"приказ", r"заявлен", r"служебн", r"справк",
)
_TRIGGER_RE = re.compile("|".join(_TRIGGER_WORDS), re.IGNORECASE)


def looks_like_doc_request(query: str) -> bool:
    """Лёгкий пред-фильтр, чтобы не дёргать LLM на каждый «привет»."""
    if not query or len(query) < 8:
        return False
    return bool(_TRIGGER_RE.search(query))


# ===== Валидация и нормализация полей перед рендером =====
# Числовые/денежные поля: чтобы в оклад не попали «пельмени». Определяем по типу
# поля в схеме ИЛИ по смыслу имени/подписи.
_NUMERIC_TYPES = {"number", "int", "integer", "float", "amount", "money", "decimal"}
_MONEY_NUM_NAME_RE = re.compile(
    r"оклад|зарплат|\bзп\b|ставк|сумм|размер|оплат|надбавк|преми|тариф|"
    r"количеств|кол-?во|\bчисло\b|salary|amount|count|price|\bsum\b|rate|salary",
    re.IGNORECASE,
)
# Первый числовой фрагмент: «100 000 пельменей» → «100 000».
_NUM_TOKEN_RE = re.compile(r"-?\d[\d  .,]*")


def _is_numeric_field(field: dict) -> bool:
    if str(field.get("type", "")).lower() in _NUMERIC_TYPES:
        return True
    hay = f"{field.get('name', '')} {field.get('label', '')}"
    return bool(_MONEY_NUM_NAME_RE.search(hay))


def _coerce_numeric(value: Any) -> str | None:
    """«100000 пельменей» → «100000»; «пельмени» → None; 50000 → «50000».
    Возвращает очищенное число-строку или None, если числа в значении нет."""
    s = str(value).strip()
    m = _NUM_TOKEN_RE.search(s)
    if not m:
        return None
    token = re.sub(r"[^\d.,-]", "", m.group(0)).strip(".,-")
    return token or None


def validate_fields(fields: dict[str, Any], template: DocTemplate) -> dict[str, Any]:
    """Приводит числовые поля к числу и отбрасывает мусор (текст в поле оклада).
    Некорректное значение обнуляется (→ None) — дальше оно считается «недостающим»."""
    schema = {f.get("name"): f for f in (template.fields_schema or []) if f.get("name")}
    out: dict[str, Any] = {}
    for k, v in (fields or {}).items():
        if v in (None, ""):
            out[k] = v
            continue
        f = schema.get(k)
        if f and _is_numeric_field(f):
            out[k] = _coerce_numeric(v)  # None, если внятного числа нет
        else:
            out[k] = v
    return out


def missing_required_fields(fields: dict[str, Any], template: DocTemplate) -> list[str]:
    """Список ИМЁН обязательных полей, которых не хватает (перевод подписи — на
    этапе показа, см. ru_field_label). По умолчанию поле обязательно (required
    отсутствует → True); опциональные помечаются явно required=False."""
    missing: list[str] = []
    for f in (template.fields_schema or []):
        name = f.get("name")
        if not name or not f.get("required", True):
            continue
        if fields.get(name) in (None, ""):
            missing.append(name)
    return missing


# ===== Русские подписи типовых HR-полей =====
# Шаблоны часто содержат латинские имена переменных ({{patronymic}}, {{position}}),
# и авто-подпись выходит английской. Для показа пользователю переводим по словарю.
RU_FIELD_LABELS: dict[str, str] = {
    "surname": "Фамилия", "lastname": "Фамилия", "last_name": "Фамилия",
    "name": "Имя", "firstname": "Имя", "first_name": "Имя",
    "patronymic": "Отчество", "middlename": "Отчество", "middle_name": "Отчество",
    "fio": "ФИО", "full_name": "ФИО", "fullname": "ФИО",
    "position": "Должность", "post": "Должность", "job": "Должность", "job_title": "Должность",
    "department": "Подразделение", "subdivision": "Подразделение", "unit": "Подразделение",
    "division": "Подразделение",
    "salary": "Оклад", "oklad": "Оклад", "wage": "Оклад", "pay": "Оклад",
    "rate": "Ставка", "tariff": "Ставка",
    "date": "Дата", "date_today": "Дата", "today": "Дата",
    "date_start": "Дата начала", "start_date": "Дата начала", "date_from": "Дата начала",
    "date_end": "Дата окончания", "end_date": "Дата окончания", "date_to": "Дата окончания",
    "birth_date": "Дата рождения", "birthdate": "Дата рождения", "dob": "Дата рождения",
    "order_number": "Номер приказа", "order_no": "Номер приказа",
    "number": "Номер", "num": "Номер", "no": "Номер",
    "employee": "Сотрудник", "worker": "Сотрудник", "employer": "Работодатель",
    "reason": "Основание", "basis": "Основание", "ground": "Основание",
    "organization": "Организация", "company": "Организация", "org": "Организация",
    "contract_number": "Номер договора", "contract_no": "Номер договора",
    "contract_date": "Дата договора",
    "vacation_days": "Дней отпуска", "days": "Количество дней", "duration": "Длительность",
    "phone": "Телефон", "email": "Эл. почта", "address": "Адрес",
    "passport": "Паспорт", "snils": "СНИЛС", "inn": "ИНН",
}

_HAS_CYRILLIC_RE = re.compile(r"[А-Яа-яЁё]")


def ru_field_label(name: str, fallback: str | None = None) -> str:
    """Русская подпись поля по его имени. Если имя незнакомо — возвращаем
    хранимую подпись (если она уже кириллицей), иначе имя как есть."""
    key = (name or "").strip().lower()
    if key in RU_FIELD_LABELS:
        return RU_FIELD_LABELS[key]
    if fallback and _HAS_CYRILLIC_RE.search(fallback):
        return fallback
    return fallback or name or ""


# «Имя неправильно — должно быть …», «исправь отчество на …», «не Иванов, а Петров» —
# намерение ИСПРАВИТЬ уже заполненное поле (а не просто дозаполнить пустое).
_CORRECTION_RE = re.compile(
    r"неправильн\w*|не\s+так\b|неверн\w*|не\s+верн\w*|ошибк\w*|ошиба\w*|"
    r"исправ\w*|поменя\w*|замен\w*|должн[оаы]\s+быть|на\s+самом\s+деле|"
    r"\bа\s+не\b|вместо\b|перепута\w*|опечат\w*|некорректн\w*",
    re.IGNORECASE,
)


def wants_correction(query: str) -> bool:
    return bool(_CORRECTION_RE.search(query or ""))


# ===== Явные намерения пользователя в диалоге генерации =====
# «Сгенерируй как есть / без обязательных полей / оставь пустым» — разрешение
# создать документ, не заполняя недостающие поля (пустые останутся пустыми).
_FORCE_GENERATE_RE = re.compile(
    r"как\s+есть|без\s+(обязательн|остальн|недоста|заполнен)|"
    r"остав(ь|ить)\s+пуст|пуст(ым|ыми|ое)|не\s+заполня|не\s+спрашива|"
    r"всё\s+равно|все\s+равно|и\s+так\s+сойд[её]т|прост[оă]\s+сгенерируй|"
    r"сгенерируй\s+(так|всё|все|документ)|не\s+важно|неважно|пропусти",
    re.IGNORECASE,
)
# «Отмена / забудь / не надо» — отказ от начатой генерации документа.
_CANCEL_RE = re.compile(
    r"\bотмен\w*|\bзабуд\w*|\bне\s+надо\b|\bне\s+нужно\b|\bотбой\b|"
    r"\bстоп\b|\bпередума\w*|\bотстав\w*|\bне\s+хочу\b",
    re.IGNORECASE,
)


def wants_force_generate(query: str) -> bool:
    return bool(_FORCE_GENERATE_RE.search(query or ""))


def wants_cancel(query: str) -> bool:
    return bool(_CANCEL_RE.search(query or ""))


def normalize_for_render(fields: dict[str, Any]) -> dict[str, Any]:
    """None → пустая строка: чтобы в документе не печаталось буквальное «None»
    для необязательных незаполненных полей."""
    return {k: ("" if v is None else v) for k, v in (fields or {}).items()}
