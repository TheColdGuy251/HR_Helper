"""Политика ПДн для сгенерированных документов.

По ТЗ документы, касающиеся персональных данных, не хранятся: они помечаются
is_pii при создании, скрываются из «Моих документов» и автоматически удаляются
по TTL вместе с сообщениями чата и пересылками в мессенджере
(services/tasks/pii_cleanup.py).
"""
from __future__ import annotations

from services.pii.scan import scan_pii_signals

# Инструменты, чьи документы всегда построены на персональных данных работников.
PII_TEMPLATE_KEYS = {
    "characteristic",        # Б1: характеристика на награду
    "employee_certificate",  # Б3: справка на работника
    "dpo_report",            # Б2: отчёт по ДПО (списки обученных)
    "dismissed_inventory",   # Б4: опись личных дел уволенных
}

# Время жизни ПДн-содержимого (сообщения, документы, пересылки), минуты.
PII_TTL_MINUTES = 60


def detect_pii_document(template_key: str | None, *texts: object) -> bool:
    """True, если документ относится к персональным данным: либо это документ
    ПДн-инструмента, либо детерминированный сканер находит ПДн в тексте
    (много ФИО или ФИО + СНИЛС/паспорт/дата рождения/табельный)."""
    if (template_key or "") in PII_TEMPLATE_KEYS:
        return True
    joined = "\n".join(str(t) for t in texts if t)
    return bool(joined) and scan_pii_signals(joined) is not None
