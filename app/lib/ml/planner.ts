import 'server-only';
import { RAG } from './config';
import { generateJson } from './llm-json';
import { SYSTEM_PROMPT_PLANNER } from './prompts';

// Планировщик запросов: естественный язык -> структурный план поиска.
//
// Вместо описания каждого частного случая формулировки регэкспами мы один раз
// спрашиваем LLM о намерении запроса и получаем структуру, по которой диспетчер
// (pipeline.ts) выбирает стратегию retrieval. Падежи, синонимы и словесные
// числительные ("сорок седьмая статья") обобщает модель.
//
// Дёшево по латентности: для явно семантических запросов (нет цифр и
// структурных триггеров) LLM не вызывается вовсе - сразу mode="semantic".

// В JS `\w` и `\b` знают только ASCII, поэтому границу слова собираем вручную
// (тот же приём, что в pipeline.ts и indexer.ts).
const W = '0-9A-Za-zА-Яа-яЁё_';
const B = `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`;

function ru(pattern: string, flags = 'i'): RegExp {
  return new RegExp(pattern.replace(/\\b/g, B).replace(/\\w/g, `[${W}]`), flags);
}

export const VALID_MODES = ['semantic', 'exact_article', 'extreme', 'range', 'compare', 'count'] as const;
export const VALID_UNITS = ['article', 'clause', 'section', 'chapter', 'paragraph'] as const;

export type PlanMode = (typeof VALID_MODES)[number];
export type PlanUnit = (typeof VALID_UNITS)[number];

export interface QueryPlan {
  mode: PlanMode;
  /** article | clause(пункт) | section(раздел) | chapter(глава) | paragraph(параграф) */
  unit: PlanUnit;
  article_nos: number[];
  extreme: 'first' | 'last' | null;
  range_n: number | null;
  range_order: 'asc' | 'desc';
  doc_hint: string | null;
  search_text: string;
}

function semanticPlan(searchText: string): QueryPlan {
  return {
    mode: 'semantic',
    unit: 'article',
    article_nos: [],
    extreme: null,
    range_n: null,
    range_order: 'asc',
    doc_hint: null,
    search_text: searchText,
  };
}

// Быстрый pre-filter: стоит ли вообще звать планировщик. Нет ни цифр, ни
// структурных слов - почти наверняка обычный смысловой вопрос, экономим вызов.
const STRUCTURAL_HINT_RE =
  /\d|стат|глав|пункт|раздел|част|перв|втор|трет|последн|финальн|заключительн|начальн|конечн|крайн|сравн|разниц|различ|отлич|против/i;

export function needsPlanner(query: string): boolean {
  return STRUCTURAL_HINT_RE.test(query || '');
}

// Референсные продолжения: "процитируй её", "а что в ней", "покажи целиком".
// Без истории их не понять - но если история есть, планировщик разрешит ссылку.
const REFERENTIAL_RE = ru(
  '\\b(её|ее|неё|нее|его|него|их|них|это|этой|этого|эту|этом|' +
    'ней|нём|нем|та|ту|той|том|там|оттуда|отсюда|выше|оно)\\b' +
    '|из\\s+н(?:его|её|ее|их)\\b' +
    '|процитир|процити|подробн|раскрой|целиком|полност|дальше|продолж'
);

function looksReferential(query: string): boolean {
  const q = (query || '').trim();
  return q.length < 30 || REFERENTIAL_RE.test(q);
}

function coerceNumberList(value: unknown): number[] {
  const src = Array.isArray(value) ? value : [value];
  const out: number[] = [];
  for (const v of src) {
    if (v === null || v === undefined) continue;
    const n = Number(String(v).replace(',', '.').trim());
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Валидирует сырой JSON модели и приводит к QueryPlan. Любое отклонение от
 * схемы безопасно деградирует в semantic - пайплайн всегда остаётся рабочим.
 */
export function normalizePlan(data: Record<string, unknown> | null, query: string): QueryPlan {
  if (!data) return semanticPlan(query);

  let mode = String(data.mode ?? 'semantic').trim().toLowerCase() as PlanMode;
  if (!(VALID_MODES as readonly string[]).includes(mode)) mode = 'semantic';

  let unit = String(data.unit ?? 'article').trim().toLowerCase() as PlanUnit;
  if (!(VALID_UNITS as readonly string[]).includes(unit)) unit = 'article';

  const articleNos = coerceNumberList(data.article_nos);

  const rawExtreme = typeof data.extreme === 'string' ? data.extreme.trim().toLowerCase() : null;
  const extreme: 'first' | 'last' | null =
    rawExtreme === 'first' || rawExtreme === 'last' ? rawExtreme : null;

  let rangeN: number | null = null;
  if (data.range_n !== null && data.range_n !== undefined) {
    const n = Number.parseInt(String(data.range_n), 10);
    if (Number.isFinite(n)) rangeN = Math.max(1, Math.min(n, 10));
  }

  let order = String(data.range_order ?? 'asc').trim().toLowerCase();
  if (order !== 'asc' && order !== 'desc') order = 'asc';

  const rawHint = typeof data.doc_hint === 'string' ? data.doc_hint.trim() : '';
  const docHint = rawHint ? rawHint.toUpperCase() : null;

  const rawText = typeof data.search_text === 'string' ? data.search_text.trim() : '';
  const searchText = rawText || query;

  // Рассогласованный план: режим требует параметра, которого нет - откатываемся
  // к semantic, а не угадываем.
  if (mode === 'exact_article' && !articleNos.length) mode = 'semantic';
  if (mode === 'extreme' && !extreme) mode = 'semantic';
  if (mode === 'range' && !rangeN) mode = 'semantic';
  // Для extreme порядок обязан быть согласован (first->asc, last->desc).
  if (mode === 'extreme') order = extreme === 'first' ? 'asc' : 'desc';

  return {
    mode,
    unit,
    article_nos: articleNos,
    extreme,
    range_n: rangeN,
    range_order: order as 'asc' | 'desc',
    doc_hint: docHint,
    search_text: searchText,
  };
}

// ---------------------------------------------------------------------------
// Регэксп-оверрайд плана
// ---------------------------------------------------------------------------
// LLM-планировщик недетерминирован: на "Что говорится в пункте 6.1 положения о
// командировках?" он может вернуть semantic или exact с unit=article (статей в
// базе нет - запрос молча проваливается в семантику и получает отказ). Явные
// сигналы в самом запросе ("пункт 6.1", "сколько разделов", "последний пункт")
// надёжнее детектировать регэкспами и поправлять план поверх ответа модели.

const UNIT_WORD_PATTERNS: [RegExp, PlanUnit][] = [
  // Порядок = приоритет; "статья" последней - она и так unit по умолчанию.
  [ru('\\bпункт\\w*|\\bп\\.\\s*\\d'), 'clause'],
  [ru('\\bраздел\\w*'), 'section'],
  [ru('\\bглав\\w*|\\bгл\\.\\s*\\d'), 'chapter'],
  [ru('\\bпараграф\\w*|§'), 'paragraph'],
  [ru('\\bстат\\w*|\\bст\\.\\s*\\d'), 'article'],
];

// Номер после структурного слова: "пункт 6.1", "раздел 2", "глава 12".
// Многоуровневые номера ("2.1.3") не берём: article_nos - числа, третья
// компонента потерялась бы (Number('2.1.3') = NaN отфильтрует их сам).
const EXACT_UNIT_NUM_RE = ru(
  '\\b(?:пункт\\w*|раздел\\w*|глав\\w*|параграф\\w*|стат\\w*|п\\.|ст\\.)\\s*№?\\s*(\\d+(?:\\.\\d+)?)\\b',
  'gi'
);
const COUNT_UNIT_RE = ru('\\bсколько\\b[\\s\\S]{0,60}?\\b(?:пункт|раздел|глав|параграф|стат)');
// Диапазон номеров: "пункты с 1 по 3", "разделы со 2 по 4".
const SPAN_UNIT_RE = ru(
  '\\b(?:пункт\\w*|раздел\\w*|глав\\w*|параграф\\w*|стат\\w*)\\s+со?\\s+(\\d+(?:\\.\\d+)?)\\s+по\\s+(\\d+(?:\\.\\d+)?)\\b'
);
const EXTREME_UNIT_RE = ru(
  '\\b(перв\\w+|начальн\\w+|последн\\w+|заключительн\\w+|финальн\\w+)\\s+(?:пункт|раздел|глав|параграф|стат)'
);

function detectUnitWord(query: string): PlanUnit | null {
  for (const [re, unit] of UNIT_WORD_PATTERNS) {
    if (re.test(query)) return unit;
  }
  return null;
}

/**
 * Поправляет план по явным сигналам запроса:
 *  - у структурного плана чинит unit (LLM ставит article по умолчанию);
 *  - semantic с явным "пункт N" / "сколько разделов" / "последний пункт"
 *    переводит в exact / count / extreme.
 * Валидный структурный план модели (кроме unit) не трогаем.
 */
export function overridePlanWithRegex(plan: QueryPlan, query: string): QueryPlan {
  const q = (query || '').trim();
  if (!q) return plan;
  const unitWord = detectUnitWord(q);
  const out: QueryPlan = { ...plan };

  if (out.mode !== 'semantic') {
    if (unitWord && out.unit !== unitWord) out.unit = unitWord;
    return out;
  }

  // "пункты с 1 по 3" -> точная выборка перечня номеров (диапазон целых, <=10).
  const span = SPAN_UNIT_RE.exec(q);
  if (span) {
    const a = Number(span[1]);
    const b = Number(span[2]);
    if (Number.isInteger(a) && Number.isInteger(b) && b >= a && b - a < 10) {
      const list = Array.from({ length: b - a + 1 }, (_, i) => a + i);
      return { ...out, mode: 'exact_article', unit: unitWord ?? out.unit, article_nos: list };
    }
  }

  EXACT_UNIT_NUM_RE.lastIndex = 0;
  const nums: number[] = [];
  for (const m of q.matchAll(EXACT_UNIT_NUM_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && !nums.includes(n)) nums.push(n);
  }
  if (nums.length) {
    return { ...out, mode: 'exact_article', unit: unitWord ?? out.unit, article_nos: nums };
  }
  if (COUNT_UNIT_RE.test(q)) {
    return { ...out, mode: 'count', unit: unitWord ?? out.unit };
  }
  const em = EXTREME_UNIT_RE.exec(q);
  if (em) {
    const extreme: 'first' | 'last' = /^(перв|начальн)/i.test(em[1]) ? 'first' : 'last';
    return {
      ...out,
      mode: 'extreme',
      unit: unitWord ?? out.unit,
      extreme,
      range_order: extreme === 'first' ? 'asc' : 'desc',
    };
  }
  return out;
}

const SCHEMA_HINT =
  '{"mode": "...", "unit": "article", "article_nos": [], ' +
  '"extreme": null, "range_n": null, "range_order": "asc", ' +
  '"doc_hint": null, "search_text": "..."}';

/**
 * Главная точка входа. Возвращает QueryPlan; при любой ошибке - semantic-план.
 *
 * `historyContext` - текст последних реплик диалога. Нужен, чтобы планировщик
 * разрешал референсные продолжения ("процитируй её" -> exact_article по статье
 * из предыдущего ответа). LLM зовём, если запрос структурный или (есть история
 * и запрос выглядит референсным).
 */
export async function planQuery(query: string, historyContext?: string | null): Promise<QueryPlan> {
  const q = (query || '').trim();
  if (!q) return semanticPlan('');

  const useContext = Boolean(historyContext) && looksReferential(q);
  let trigger = needsPlanner(q) || useContext;

  // Semantic-router добирает структурные перефразировки без триггер-слов.
  if (!trigger && RAG.useSemanticRouter) {
    const { isStructural } = await import('./intent');
    if (await isStructural(q)) trigger = true;
  }
  if (!trigger) return semanticPlan(q);

  const userMsg = useContext
    ? `Контекст последних реплик диалога:\n${historyContext}\n\n` +
      `Текущий запрос (разреши ссылки вроде «её/эту/ту статью» по контексту):\n${q}`
    : q;

  let data: Record<string, unknown> | null = null;
  try {
    data = await generateJson(SYSTEM_PROMPT_PLANNER, userMsg, SCHEMA_HINT);
  } catch {
    return semanticPlan(q);
  }
  return normalizePlan(data, q);
}
