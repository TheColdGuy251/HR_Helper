import 'server-only';
import { RAG } from './config';
import { generateJson } from './llm-json';
import { SYSTEM_PROMPT_PLANNER } from './prompts';

// Планировщик запросов: естественный язык → структурный план поиска.
// Порт services/rag/planner.py.
//
// Вместо описания каждого частного случая формулировки регэкспами мы один раз
// спрашиваем LLM о НАМЕРЕНИИ запроса и получаем структуру, по которой диспетчер
// (pipeline.ts) выбирает стратегию retrieval. Падежи, синонимы и словесные
// числительные («сорок седьмая статья») обобщает модель.
//
// Дёшево по латентности: для явно семантических запросов (нет цифр и
// структурных триггеров) LLM не вызывается вовсе — сразу mode="semantic".

// В Python `\w` и `\b` знают кириллицу, в JS — только ASCII, поэтому границу
// слова собираем вручную (тот же приём, что в pipeline.ts и indexer.ts).
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
  /** article | clause(пункт) | section(раздел) | chapter(глава) | paragraph(§) */
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
// структурных слов — почти наверняка обычный смысловой вопрос, экономим вызов.
const STRUCTURAL_HINT_RE =
  /\d|стат|глав|пункт|раздел|част|перв|втор|трет|последн|финальн|заключительн|начальн|конечн|крайн|сравн|разниц|различ|отлич|против/i;

export function needsPlanner(query: string): boolean {
  return STRUCTURAL_HINT_RE.test(query || '');
}

// Референсные продолжения: «процитируй её», «а что в ней», «покажи целиком».
// Без истории их не понять — но если история есть, планировщик разрешит ссылку.
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
 * схемы безопасно деградирует в semantic — пайплайн всегда остаётся рабочим.
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

  // Рассогласованный план: режим требует параметра, которого нет — откатываемся
  // к semantic, а не угадываем.
  if (mode === 'exact_article' && !articleNos.length) mode = 'semantic';
  if (mode === 'extreme' && !extreme) mode = 'semantic';
  if (mode === 'range' && !rangeN) mode = 'semantic';
  // Для extreme порядок обязан быть согласован (first→asc, last→desc).
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

const SCHEMA_HINT =
  '{"mode": "...", "unit": "article", "article_nos": [], ' +
  '"extreme": null, "range_n": null, "range_order": "asc", ' +
  '"doc_hint": null, "search_text": "..."}';

/**
 * Главная точка входа. Возвращает QueryPlan; при любой ошибке — semantic-план.
 *
 * `historyContext` — текст последних реплик диалога. Нужен, чтобы планировщик
 * разрешал референсные продолжения («процитируй её» → exact_article по статье
 * из предыдущего ответа). LLM зовём, если запрос структурный ИЛИ (есть история
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
