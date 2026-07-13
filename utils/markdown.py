"""Минимальный безопасный markdown → HTML для страницы просмотра документов.
Без внешних зависимостей; экранирует HTML, поддерживает базовый набор синтаксиса."""
from __future__ import annotations

import html
import re


def _inline(s: str) -> str:
    # s уже экранирован. Применяем инлайновые преобразования.
    s = re.sub(r"`([^`]+?)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(
        r"\[([^\]]+)\]\((https?://[^)\s]+)\)",
        r'<a href="\2" target="_blank" rel="noopener">\1</a>',
        s,
    )
    return s


def md_to_html(text: str) -> str:
    """Преобразует markdown в HTML. Достаточно для предпросмотра ЛНА/инструкций."""
    text = (text or "").replace("\r\n", "\n")
    lines = text.split("\n")
    out: list[str] = []
    para: list[str] = []
    in_code = False
    code_buf: list[str] = []

    def flush_para() -> None:
        if para:
            out.append("<p>" + "<br>".join(_inline(html.escape(x)) for x in para) + "</p>")
            para.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        # Блоки кода ```
        if line.strip().startswith("```"):
            if not in_code:
                flush_para()
                in_code = True
                code_buf = []
            else:
                out.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")
                in_code = False
            i += 1
            continue
        if in_code:
            code_buf.append(line)
            i += 1
            continue

        stripped = line.strip()
        h = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if h:
            flush_para()
            lvl = len(h.group(1))
            out.append(f"<h{lvl}>{_inline(html.escape(h.group(2)))}</h{lvl}>")
            i += 1
            continue
        if re.match(r"^([-*_])\1{2,}$", stripped):
            flush_para()
            out.append("<hr>")
            i += 1
            continue
        # Списки
        if re.match(r"^[-*+]\s+", stripped) or re.match(r"^\d+[.)]\s+", stripped):
            flush_para()
            ordered = bool(re.match(r"^\d+[.)]\s+", stripped))
            items: list[str] = []
            while i < len(lines):
                st = lines[i].strip()
                m = re.match(r"^[-*+]\s+(.*)$", st) or re.match(r"^\d+[.)]\s+(.*)$", st)
                if not m:
                    break
                items.append(_inline(html.escape(m.group(1))))
                i += 1
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{x}</li>" for x in items) + f"</{tag}>")
            continue
        if stripped == "":
            flush_para()
            i += 1
            continue
        para.append(stripped)
        i += 1

    if in_code:
        out.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")
    flush_para()
    return "\n".join(out)
