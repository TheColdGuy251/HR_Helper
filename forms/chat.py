from __future__ import annotations

from pydantic import BaseModel, Field


class DialogueCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)


class DialoguePatch(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    draft: str | None = Field(default=None, max_length=20000)


class ChatStreamRequest(BaseModel):
    session_id: str
    message: str | None = None
    assistant_message_id: int | None = None
    # Ретрай: перегенерировать ответ на тот же вопрос как НОВЫЙ вариант (ветку).
    retry_of: int | None = None
    last_seq: int = 0
    use_rag: bool = True
    temperature: float | None = None
    # Быстрый набор FAQ: id записи faq_entries → детерминированный ответ без LLM
    faq_id: int | None = None


class VariantSwitchRequest(BaseModel):
    session_id: str
    message_id: int          # текущий показываемый вариант (ответа ИЛИ сообщения пользователя)
    direction: int = 0       # -1 предыдущий, +1 следующий (0 — не двигать)


class EditMessageRequest(BaseModel):
    session_id: str
    message_id: int          # редактируемое сообщение пользователя
    text: str                # новая формулировка


class AbortRequest(BaseModel):
    session_id: str
    assistant_message_id: int | None = None


class MarkReadRequest(BaseModel):
    session_id: str
    message_ids: list[int] = Field(default_factory=list)


class GenerateDocRequest(BaseModel):
    template_key: str
    fields: dict
    title: str | None = None
