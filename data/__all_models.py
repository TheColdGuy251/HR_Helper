# Импорт всех моделей для регистрации в SqlAlchemyBase.metadata
from data.users import User
from data.dialogues import Dialogue
from data.chat_sessions import ChatSession
from data.chat_message import ChatMessage
from data.my_documents import MyDocuments
from data.kb_documents import KBDocument
from data.kb_sources import KBSource
from data.doc_templates import DocTemplate
from data.template_categories import TemplateCategory
from data.session_documents import SessionDocument
from data.pii import PIIPerson, PIIDocument, PIIAuditLog
from data.kb_links import KBLink
from data.chat_feedback import ChatFeedback
from data.user_message import (
    UserMessage, MessengerRead, UserMessageFile, UserMessageReaction,
    Poll, PollOption, PollVote,
)
from data.notifications import Notification, NotificationRead
from data.push_subscription import PushSubscription
from data.faq_entries import FAQEntry
from data.news import NewsPost, NewsMedia, NewsPoll, NewsPollOption, NewsPollVote

__all__ = [
    "User",
    "Dialogue",
    "ChatSession",
    "ChatMessage",
    "MyDocuments",
    "KBDocument",
    "KBSource",
    "DocTemplate",
    "TemplateCategory",
    "SessionDocument",
    "PIIPerson",
    "PIIDocument",
    "PIIAuditLog",
    "KBLink",
    "ChatFeedback",
    "UserMessage",
    "MessengerRead",
    "UserMessageFile",
    "UserMessageReaction",
    "Poll",
    "PollOption",
    "PollVote",
    "Notification",
    "NotificationRead",
    "PushSubscription",
    "FAQEntry",
    "NewsPost",
    "NewsMedia",
    "NewsPoll",
    "NewsPollOption",
    "NewsPollVote",
]
