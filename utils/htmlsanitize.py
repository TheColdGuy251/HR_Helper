"""Whitelist-санитайзер HTML из rich-редактора новостей.

Редактор (contenteditable) присылает произвольный HTML — прежде чем сохранить его
в БД и показать всем сотрудникам, вырезаем всё, что может привести к XSS: скрипты,
обработчики on*, опасные схемы URL, неизвестные теги. Оставляем безопасный набор
форматирования + <img> только на наш media-эндпоинт. Зависит только от lxml
(уже в requirements)."""

from __future__ import annotations

import html as _html
import re

from lxml import etree
from lxml import html as lxml_html

# Разрешённые CSS-классы: наши (news-*) и FontAwesome (fa/fas/far/fab, fa-*) —
# чтобы редактор мог вставлять оформленные элементы (карточка-документ с иконкой),
# но нельзя было подменить произвольные стили приложения.
_CLASS_RE = re.compile(r"^(news-[a-z0-9-]+|fa[bslr]?|fa-[a-z0-9-]+)$")

_ALLOWED_TAGS = {
    "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "strike",
    "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "a", "img",
    "span", "div", "pre", "code", "figure", "figcaption",
}

_ALLOWED_ATTRS = {
    "a": {"href", "title", "target", "rel"},
    "img": {"src", "alt", "width", "height"},
}

# Числовые атрибуты — оставляем только если это целое число (защита от инъекций
# через width="…javascript" и т.п.).
_NUMERIC_ATTRS = {"width", "height"}

# Теги, которые вырезаем вместе с содержимым (не просто разворачиваем).
_DROP_WITH_CONTENT = (
    "script", "style", "iframe", "object", "embed", "form", "input",
    "button", "textarea", "select", "link", "meta", "svg", "math", "noscript",
)


def _safe_url(val: str, tag: str) -> bool:
    v = (val or "").strip()
    if not v:
        return False
    low = v.lower()
    if low.startswith(("javascript:", "data:", "vbscript:", "file:")):
        return False
    if tag == "img":
        # Картинки — только наши загруженные (через /api/news/media/…).
        return v.startswith("/api/news/media/")
    # Ссылки: относительные, якоря, http(s), mailto, tel.
    if v.startswith(("/", "#")):
        return True
    return low.startswith(("http://", "https://", "mailto:", "tel:"))


def sanitize_html(raw: str) -> str:
    """Возвращает безопасный HTML-фрагмент. Неизвестные теги разворачиваются
    (текст сохраняется), опасные — удаляются целиком, атрибуты фильтруются."""
    if not raw or not raw.strip():
        return ""
    try:
        root = lxml_html.fragment_fromstring(raw, create_parent="div")
    except Exception:
        # Не распарсилось — отдаём как экранированный текст.
        return _html.escape(raw)

    # Опасные элементы — вон вместе с содержимым.
    for bad in root.xpath("|".join(f"//{t}" for t in _DROP_WITH_CONTENT)):
        parent = bad.getparent()
        if parent is not None:
            parent.remove(bad)

    for el in list(root.iter()):
        if el is root:
            continue
        tag = el.tag
        if not isinstance(tag, str):
            # комментарии / processing-instructions
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
            continue
        t = tag.lower()
        if t not in _ALLOWED_TAGS:
            el.drop_tag()  # снять тег, оставить текст и детей
            continue
        allowed = _ALLOWED_ATTRS.get(t, set())
        for name in list(el.attrib.keys()):
            n = name.lower()
            if n == "class":
                toks = [c for c in (el.attrib[name] or "").split() if _CLASS_RE.match(c)]
                if toks:
                    el.attrib[name] = " ".join(toks)
                else:
                    del el.attrib[name]
                continue
            if n.startswith("on") or n not in allowed:
                del el.attrib[name]
                continue
            if n in ("href", "src") and not _safe_url(el.attrib[name], t):
                del el.attrib[name]
            elif n in _NUMERIC_ATTRS and not str(el.attrib[name]).strip().isdigit():
                del el.attrib[name]
        if t == "a":
            if not el.get("href"):
                el.drop_tag()
                continue
            el.set("rel", "noopener noreferrer")
            el.set("target", "_blank")
        if t == "img" and not el.get("src"):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)

    # Собираем внутренний HTML обёртки.
    out = root.text or ""
    for child in root:
        out += etree.tostring(child, encoding="unicode", method="html")
    return out.strip()
