from __future__ import annotations

from pathlib import Path

from services.parsers.base import ParsedDocument, format_table


def parse_xls(path: str | Path) -> ParsedDocument:
    """Нативный парсер старого Excel .xls (без LibreOffice) через xlrd. Каждый лист →
    блок «Лист: <имя>», строки — с сохранением связи строка↔столбец."""
    path = Path(path)
    import xlrd

    wb = xlrd.open_workbook(str(path))
    parts: list[str] = []
    for sh in wb.sheets():
        if sh.nrows == 0:
            continue
        rows: list[list[str]] = []
        for r in range(sh.nrows):
            cells = []
            for c in range(sh.ncols):
                v = sh.cell_value(r, c)
                # xlrd отдаёт числа как float — целые печатаем без .0
                if isinstance(v, float) and v.is_integer():
                    v = int(v)
                cells.append("" if v is None else str(v).strip())
            rows.append(cells)
        table_lines = format_table(rows)
        if table_lines:
            parts.append(f"Лист: {sh.name}")
            parts.extend(table_lines)

    return ParsedDocument(
        text="\n\n".join(parts),
        title=path.stem,
        source_uri=str(path),
        source_type="local",
        mime_type="application/vnd.ms-excel",
    )
