"""Мини-харнес для измерения качества RAG-поиска (и опционально генерации).

Запуск:
    python eval/eval_rag.py            # только retrieval-recall (быстро, без LLM)
    python eval/eval_rag.py --gen      # + проверка, что модель не отказывает

Метрики:
    - retrieval recall: доля вопросов, где среди найденных чанков есть хотя бы одна
      ОЖИДАЕМАЯ статья (и средняя доля покрытия ожидаемых статей);
    - answer rate (--gen): доля вопросов, на которые модель дала ответ, а не отказ.

Цель — измерять любые правки RAG за секунды, а не «спросил один вопрос — вроде ок».
Требуется поднятый Qdrant и проиндексированный ТК.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import settings
from data.db_session import global_init
from services.rag.chunker import parse_article_no


# (вопрос, {ожидаемые номера статей ТК РФ}) — общеизвестные соответствия.
GOLD: list[tuple[str, set[float]]] = [
    ("В каких случаях работодатель может уволить сотрудника?", {77, 81}),
    ("Как уволить работника за прогул?", {81}),
    ("Что должно быть указано в трудовом договоре?", {57}),
    ("Какие документы предъявляются при приёме на работу?", {65}),
    ("Что такое испытательный срок при приёме на работу?", {70}),
    ("Какова продолжительность ежегодного оплачиваемого отпуска?", {115}),
    ("Как оплачивается работа в выходной или праздничный день?", {153}),
    ("Что такое сверхурочная работа?", {99}),
    ("Как уволиться по собственному желанию?", {80}),
    ("Какие бывают дисциплинарные взыскания?", {192}),
    ("Каков порядок применения дисциплинарного взыскания?", {193}),
    ("В какие сроки выплачивается заработная плата?", {136}),
    ("Какова нормальная продолжительность рабочего времени?", {91}),
    ("Какие гарантии при сокращении численности или штата?", {178, 180}),
    ("Как оформляется приём на работу?", {68}),
    ("Каков общий порядок оформления увольнения?", {84.1}),
    ("Положен ли отпуск без сохранения заработной платы?", {128}),
    ("Какие основания прекращения трудового договора существуют?", {77}),
    ("Что такое неполное рабочее время?", {93}),
    ("Как предоставляется ежегодный отпуск?", {114, 122}),
    ("Мой сотрудник заболел, что делать?", {183}),
    ("Можно ли уволить сотрудника на больничном?", {81}),
]


def _retrieved_articles(chunks) -> set[float]:
    out: set[float] = set()
    for c in chunks:
        no = parse_article_no(c.text)
        if no is not None:
            out.add(no)
    return out


# ---------------------------------------------------------------------------
# ТИУ-набор: вопросы по внутренним HR-процессам (из faq.json). Здесь нет номеров
# статей — «попадание» = хотя бы одна из ожидаемых характерных фраз ОТВЕТА нашлась
# среди извлечённых чанков. Запуск: python eval/eval_rag.py --tiu
# ---------------------------------------------------------------------------
GOLD_TIU: list[tuple[str, list[str]]] = [
    ("Как часто проходит аттестация АУП и УВП?", ["не реже 1 раза в 5 лет"]),
    ("Кто не подлежит аттестации АУП?", ["менее 1 года", "беременные женщины"]),
    ("Могут ли уволить по результатам аттестации?", ["неудовлетворительные результаты"]),
    ("Как пройти аттестацию досрочно?", ["не ранее, чем через 1 год после назначения"]),
    ("Сколько по времени длится аттестация?", ["5-15 мин", "10-30 мин"]),
    ("Как часто педработник проходит аттестацию на соответствие должности?", ["1 раз в 5 лет"]),
    ("На какой срок устанавливается квалификационная категория?", ["без указания срока действия", "бессрочно"]),
    ("Где найти шаблон должностной инструкции?", ["Типовые должностные инструкции"]),
    ("Что нужно для звания Ветеран труда федерального значения?", ["Ведомственная награда"]),
    ("Как наградить работника?", ["Ходатайство о награждении", "Положения о наградах"]),
    ("Как попасть в план обучения?", ["План обязательного ДПО"]),
    ("Как оформить внеплановое обучение?", ["служебную записку на имя ректора"]),
    ("Что делать при несчастном случае со студентом?", ["Оказать первую помощь", "оценить обстановку"]),
    ("Какова периодичность медосмотра?", ["1 раз в год"]),
    ("Какой срок действия психиатрического заключения?", ["не позднее двух лет"]),
    ("Как стать заведующим кафедрой?", ["избрание по конкурсу", "выборной"]),
    ("Что такое грант в ТИУ?", ["грантовой поддержке"]),
    ("Как попасть в резерв управленческих кадров?", ["формирования и подготовки резерва кадров"]),
]


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _phrase_found(haystack: str, phrase: str) -> bool:
    """Подстрока с игнорированием регистра и различий в пробелах."""
    pat = re.compile(r"\s+".join(re.escape(w) for w in phrase.split()), re.IGNORECASE)
    return bool(pat.search(haystack))


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # консоль Windows бывает cp1251
    except Exception:
        pass
    gen = "--gen" in sys.argv
    global_init(str(settings.db_file))

    from services.rag.indexer import get_indexer
    from services.rag.pipeline import get_pipeline

    get_indexer()._refresh_bm25(None)
    pipe = get_pipeline()

    if "--tiu" in sys.argv:
        _run_tiu(pipe, gen)
        return

    hits = 0
    coverage_sum = 0.0
    answered = 0
    rows = []
    for q, expected in GOLD:
        chunks, _ = pipe._retrieve(q)
        got = _retrieved_articles(chunks)
        inter = expected & got
        hit = bool(inter)
        hits += hit
        coverage_sum += len(inter) / len(expected)

        ans_mark = ""
        if gen:
            ans = "".join(pipe.answer_stream(q, use_rag=True).answer_stream).lower()
            refused = "нет информаци" in ans or "отсутству" in ans or "недоступна" in ans
            answered += not refused
            ans_mark = " | ОТКАЗ" if refused else " | ответ"

        rows.append(
            f"  [{'OK ' if hit else 'MISS'}] ждали {sorted(expected)} нашли "
            f"{sorted(got)[:6]}{ans_mark}  <- {q[:50]}"
        )

    n = len(GOLD)
    print("\n".join(rows))
    print("\n=== ИТОГ ===")
    print(f"retrieval recall (хотя бы 1 статья): {hits}/{n} = {hits / n:.0%}")
    print(f"средняя доля покрытия ожидаемых статей: {coverage_sum / n:.0%}")
    if gen:
        print(f"answer rate (не отказ): {answered}/{n} = {answered / n:.0%}")


def _run_tiu(pipe, gen: bool) -> None:
    """ТИУ-набор: recall по характерным фразам ответа среди извлечённых чанков."""
    hits = 0
    answered = 0
    rows = []
    for q, phrases in GOLD_TIU:
        chunks, _ = pipe._retrieve(q)
        blob = _norm("\n".join(c.text for c in chunks))
        matched = [p for p in phrases if _phrase_found(blob, p)]
        hit = bool(matched)
        hits += hit

        ans_mark = ""
        if gen:
            ans = "".join(pipe.answer_stream(q, use_rag=True).answer_stream).lower()
            refused = "нет информаци" in ans or "отсутству" in ans or "недоступна" in ans
            answered += not refused
            ans_mark = " | ОТКАЗ" if refused else " | ответ"

        rows.append(
            f"  [{'OK ' if hit else 'MISS'}] нашли фразы {matched if matched else '—'}"
            f"{ans_mark}  <- {q[:55]}"
        )

    n = len(GOLD_TIU)
    print("\n".join(rows))
    print("\n=== ИТОГ (ТИУ FAQ) ===")
    print(f"retrieval recall (нашлась ожидаемая фраза): {hits}/{n} = {hits / n:.0%}")
    if gen:
        print(f"answer rate (не отказ): {answered}/{n} = {answered / n:.0%}")


if __name__ == "__main__":
    main()
