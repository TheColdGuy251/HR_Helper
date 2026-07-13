from __future__ import annotations

import re
from dataclasses import dataclass

from config import settings


_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n+")
_SENT_SPLIT = re.compile(r"(?<=[.!?…])\s+(?=[А-ЯA-ZЁ0-9])")

# Маркер начала статьи нормативного акта: «Статья 5.», «Статья 22.», «Статья 84.1»
_ARTICLE_HEAD = re.compile(r"(?m)^\s*Статья\s+\d+(?:\.\d+)?\.?", re.IGNORECASE)
# Маркер начала главы: «Глава 1.», «Глава II.»
_CHAPTER_HEAD = re.compile(r"(?m)^\s*Глава\s+[\dIVXLC]+\.?", re.IGNORECASE)


@dataclass
class Chunk:
    text: str
    index: int
    char_start: int
    char_end: int
    # Метаданные нормативных актов («Статья N») — для навигации по статьям.
    article_no: float | None = None
    is_article_head: bool = False
    # Обобщённая структурная единица для НЕ-кодексных документов:
    # раздел/глава/пункт/параграф. unit_no — канонический номер-строка («3», «3.2»),
    # unit_ord — float для сортировки (extreme/range), is_unit_head — заголовок единицы.
    unit_type: str | None = None  # section | chapter | clause | paragraph
    unit_no: str | None = None
    unit_ord: float | None = None
    is_unit_head: bool = False


# Номер статьи из начала чанка: «Статья 81.», «статья 84.1»,
# а также из маркера-продолжения «[Статья 81. … — продолжение] …».
_ARTICLE_NO_RE = re.compile(r"^\s*\[?\s*стать\w*\s+(\d+(?:\.\d+)?)", re.IGNORECASE)


def parse_article_no(text: str) -> float | None:
    """Возвращает номер статьи (float, чтобы «84.1» сравнивалось корректно) или None."""
    m = _ARTICLE_NO_RE.match(text or "")
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _approx_token_count(text: str) -> int:
    # Грубая оценка: ~4 символа на токен для смешанного RU/EN
    return max(1, len(text) // 4)


def _looks_like_legal_act(text: str) -> bool:
    """Эвристика: считаем документ нормативным актом, если содержит >= 5 заголовков
    статей. Тогда применяем структурный чанкер."""
    return len(_ARTICLE_HEAD.findall(text or "")) >= 5


def _split_legal_text(
    text: str, chunk_size: int, overlap: int
) -> list[Chunk]:
    """Структурный сплиттер для нормативных актов: каждый чанк — это одна статья
    (или её часть), всегда начинается с маркера 'Статья N. …'."""
    # Положения статей
    matches = list(_ARTICLE_HEAD.finditer(text))
    if not matches:
        return split_text(text, chunk_size, overlap)

    # Префикс до первой статьи (преамбула, главы и т.п.) — отдельным чанком, если есть
    chunks: list[Chunk] = []

    def _add(t: str, start: int, end: int, is_head: bool = False) -> None:
        t = t.strip()
        if not t:
            return
        chunks.append(
            Chunk(
                text=t,
                index=len(chunks),
                char_start=start,
                char_end=end,
                article_no=parse_article_no(t),
                is_article_head=is_head,
            )
        )

    first_start = matches[0].start()
    if first_start > 0:
        preface = text[:first_start]
        if preface.strip():
            _add(preface, 0, first_start)

    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[start:end].strip()
        if not block:
            continue

        # Заголовок статьи (первая строка целиком)
        first_nl = block.find("\n")
        head = block[:first_nl] if first_nl > 0 else block
        head = head.strip()[:160]

        if len(block) <= chunk_size:
            _add(block, start, end, is_head=True)
            continue

        # Длинная статья — режем простым жадным сплиттером (без структурного режима,
        # чтобы нумерованные пункты внутри статьи не подменили маркер «продолжение»).
        sub = _split_plain(block, chunk_size, overlap)
        for j, s in enumerate(sub):
            if j == 0:
                _add(s.text, start + s.char_start, start + s.char_end, is_head=True)
            else:
                tagged = f"[{head} — продолжение] {s.text}"
                _add(tagged, start + s.char_start, start + s.char_end)
    return chunks


# ===== Структурные документы НЕ нормативного типа =====
# Инструкции, положения, регламенты, ЛНА часто структурированы заголовками
# «Раздел/Глава/§» и нумерацией «1.», «2.3», но без «Статья N». Для них мы тоже
# хотим осмысленные границы чанков и КОНТЕКСТ заголовка в каждом чанке —
# «[Раздел 3. Оплата труда › 3.2 Сроки выплаты] …». Это сильно поднимает точность
# и dense-, и BM25-поиска и качество цитирования на больших разнородных корпусах.

_HEADING_KEYWORD_RE = re.compile(
    r"^(раздел|глава|подраздел|часть|параграф|§|приложение)\b", re.IGNORECASE
)
# Нумерованный заголовок: «1. …», «2.3 …», «3.1.2 …» (короткая строка-титул).
_HEADING_NUM_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+\S")


def _heading_level(line: str) -> int | None:
    """Уровень заголовка (1 — верхний) или None, если строка не похожа на заголовок."""
    s = line.strip()
    if not s or len(s) > 120:
        return None
    if _HEADING_KEYWORD_RE.match(s):
        low = s.lower()
        if low.startswith(("раздел", "часть", "приложение")):
            return 1
        if low.startswith("глава"):
            return 2
        return 3  # подраздел / параграф / §
    m = _HEADING_NUM_RE.match(s)
    if m and len(s) <= 100:
        return m.group(1).count(".") + 1  # глубина нумерации = уровень
    # Короткий заголовок КАПСОМ («ОБЩИЕ ПОЛОЖЕНИЯ»)
    letters = [c for c in s if c.isalpha()]
    if len(letters) >= 4 and len(s.split()) >= 2 and len(s) <= 80:
        if sum(1 for c in letters if c.isupper()) / len(letters) >= 0.8:
            return 1
    return None


def _count_headings(text: str) -> int:
    return sum(1 for ln in (text or "").split("\n") if _heading_level(ln) is not None)


# ===== Разбор структурной единицы из заголовка (для навигации) =====
_ROMAN_RE = re.compile(r"^[IVXLCDM]+$", re.IGNORECASE)
_DOTTED_NUM_RE = re.compile(r"^\d+(?:\.\d+)*$")
# Ключевое слово заголовка → тип единицы.
_UNIT_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("подраздел", "section"),
    ("раздел", "section"),
    ("часть", "section"),
    ("глава", "chapter"),
    ("параграф", "paragraph"),
    ("§", "paragraph"),
)


def _roman_to_int(s: str) -> int | None:
    vals = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    total, prev = 0, 0
    for ch in reversed(s.upper()):
        v = vals.get(ch, 0)
        if v == 0:
            return None
        total += -v if v < prev else v
        prev = max(prev, v)
    return total or None


def _canon_and_ord(token: str) -> tuple[str | None, float | None]:
    """«3.»→('3',3.0); «3.2»→('3.2',3.002); «II»→('2',2.0)."""
    t = token.strip().strip(".").strip()
    if not t:
        return (None, None)
    if _DOTTED_NUM_RE.match(t):
        comps = [int(x) for x in t.split(".")]
        ordv = sum(c / (1000 ** i) for i, c in enumerate(comps))
        return (".".join(str(c) for c in comps), ordv)
    if _ROMAN_RE.match(t):
        n = _roman_to_int(t)
        return (str(n), float(n)) if n else (None, None)
    return (None, None)


def _parse_unit(heading: str | None) -> tuple[str | None, str | None, float | None]:
    """Заголовок → (unit_type, unit_no, unit_ord). None, если номер не распознан."""
    if not heading:
        return (None, None, None)
    s = heading.strip()
    low = s.lower()
    for kw, typ in _UNIT_KEYWORDS:
        if low.startswith(kw):
            rest = s[len(kw):].strip(" .№N\t")
            token = rest.split()[0] if rest.split() else ""
            no, ordv = _canon_and_ord(token)
            return (typ, no, ordv) if no else (None, None, None)
    m = _HEADING_NUM_RE.match(s)
    if m:
        no, ordv = _canon_and_ord(m.group(1))
        return ("clause", no, ordv) if no else (None, None, None)
    return (None, None, None)


def _paragraph_units(text: str, chunk_size: int) -> list[tuple[str, int, int]]:
    """Разбивает текст на единицы (параграф или предложение) с char-офсетами."""
    units: list[tuple[str, int, int]] = []
    cursor = 0
    for para in _PARAGRAPH_SPLIT.split(text):
        para_clean = para.strip()
        if not para_clean:
            cursor = text.find("\n\n", cursor)
            if cursor == -1:
                break
            cursor += 2
            continue
        start = text.find(para_clean, cursor)
        if start == -1:
            start = cursor
        end = start + len(para_clean)
        cursor = end
        if len(para_clean) <= chunk_size:
            units.append((para_clean, start, end))
        else:
            sub_cursor = start
            for sent in _SENT_SPLIT.split(para_clean):
                if not sent.strip():
                    continue
                s_start = text.find(sent.strip(), sub_cursor)
                if s_start == -1:
                    s_start = sub_cursor
                s_end = s_start + len(sent.strip())
                sub_cursor = s_end
                units.append((sent.strip(), s_start, s_end))
    return units


def _pack(
    units: list[tuple[str, int, int]], chunk_size: int, overlap: int
) -> list[tuple[str, int, int]]:
    """Жадно склеивает единицы до chunk_size с overlap из хвоста предыдущего."""
    packed: list[tuple[str, int, int]] = []
    buf_text, buf_start, buf_end = "", 0, 0
    for unit_text, u_start, u_end in units:
        if not buf_text:
            buf_text, buf_start, buf_end = unit_text, u_start, u_end
            continue
        candidate = buf_text + "\n" + unit_text
        if len(candidate) <= chunk_size:
            buf_text, buf_end = candidate, u_end
        else:
            packed.append((buf_text.strip(), buf_start, buf_end))
            if overlap > 0 and packed:
                tail = packed[-1][0][-overlap:]
                buf_text = tail + "\n" + unit_text
                buf_start = max(0, packed[-1][2] - overlap)
            else:
                buf_text, buf_start = unit_text, u_start
            buf_end = u_end
    if buf_text.strip():
        packed.append((buf_text.strip(), buf_start, buf_end))
    return packed


def _split_plain(text: str, chunk_size: int, overlap: int) -> list[Chunk]:
    units = _paragraph_units(text, chunk_size)
    return [
        Chunk(text=t, index=i, char_start=st, char_end=en)
        for i, (t, st, en) in enumerate(_pack(units, chunk_size, overlap))
    ]


def _split_structured_text(text: str, chunk_size: int, overlap: int) -> list[Chunk]:
    """Сплиттер по заголовкам: накапливает иерархию, префиксует чанк «путём» в
    структуре и проставляет unit-метаданные (тип/номер ближайшего заголовка) —
    чтобы работала навигация «раздел 3», «последний пункт», «сколько глав»."""
    stack: dict[int, str] = {}
    blocks: list[tuple[str, str | None, str]] = []  # (path, heading, body)
    cur_path, cur_head, cur_body = "", None, []  # type: ignore[var-annotated]

    def flush() -> None:
        body = "\n".join(cur_body).strip()
        if body or cur_head:
            blocks.append((cur_path, cur_head, body))

    for raw in text.split("\n"):
        s = raw.strip()
        if not s:
            cur_body.append("")
            continue
        lvl = _heading_level(s)
        if lvl is not None:
            flush()
            stack = {k: v for k, v in stack.items() if k < lvl}
            stack[lvl] = s
            cur_path = " › ".join(stack[k] for k in sorted(stack))
            cur_head, cur_body = s, []
        else:
            cur_body.append(s)
    flush()

    chunks: list[Chunk] = []
    for path, heading, body in blocks:
        utype, uno, uord = _parse_unit(heading)
        if not body:
            # Навигируемый head-чанк из одного заголовка (раздел без прямого текста).
            chunks.append(
                Chunk(
                    text=f"[{path}]" if path else (heading or ""),
                    index=len(chunks), char_start=0, char_end=0,
                    unit_type=utype, unit_no=uno, unit_ord=uord,
                    is_unit_head=bool(utype),
                )
            )
            continue
        pieces = _pack(_paragraph_units(body, chunk_size), chunk_size, overlap)
        for j, (piece, _st, _en) in enumerate(pieces):
            prefixed = f"[{path}]\n{piece}" if path else piece
            chunks.append(
                Chunk(
                    text=prefixed, index=len(chunks), char_start=0, char_end=0,
                    unit_type=utype, unit_no=uno, unit_ord=uord,
                    is_unit_head=(j == 0 and bool(utype)),
                )
            )

    return chunks or _split_plain(text, chunk_size, overlap)


def split_text(
    text: str,
    chunk_size: int | None = None,
    overlap: int | None = None,
) -> list[Chunk]:
    """Иерархический сплиттер с авто-выбором стратегии по структуре документа:
    - нормативный акт (≥5 «Статья N») → чанк = статья (+ article_no для навигации);
    - структурированный (заголовки «Раздел/Глава/N.N») → чанк с контекстом-путём;
    - прочее → жадная склейка параграфов/предложений.
    """
    chunk_size = chunk_size or settings.chunk_size
    overlap = overlap or settings.chunk_overlap

    text = (text or "").strip()
    if not text:
        return []

    if _looks_like_legal_act(text):
        return _split_legal_text(text, chunk_size, overlap)
    if _count_headings(text) >= 3:
        return _split_structured_text(text, chunk_size, overlap)
    return _split_plain(text, chunk_size, overlap)
