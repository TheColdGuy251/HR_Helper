import 'server-only';
import { expandAbbreviations } from './aliases';
import { RAG } from './config';
import { generateText, isLlmAvailable, type ChatMessage } from './llm';
import { extractJson } from './llm-json';
import {
  SYSTEM_PROMPT_DECOMPOSE,
  SYSTEM_PROMPT_HYDE,
  SYSTEM_PROMPT_QUERY_REWRITE,
  SYSTEM_PROMPT_SELFCHECK,
  SYSTEM_PROMPT_SUMMARY,
  SYSTEM_PROMPT_TOPIC,
} from './prompts';

// Продвинутые надстройки RAG: HyDE, декомпозиция запроса, переписывание при
// отрицаниях, классификация тем, self-check ответа и сводка диалога.
// Порт одноимённых методов RAGPipeline (services/rag/pipeline.py).
//
// Все они опциональны и управляются флагами RAG_* (см. config.ts): при
// недоступной модели или неразобранном ответе каждая функция молча возвращает
// исходное значение — основной путь ответа от этого не ломается.

// Отрицания: «не выплатить», «нельзя», «запрещено», «без согласия».
const W = '0-9A-Za-zА-Яа-яЁё_';
const B = `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`;
const NEGATION_RE = new RegExp(
  `${B}(не\\s+[${W}]{2,}|нельзя|запрещ[${W}]+|без\\s+[${W}]{2,}|невозможн[${W}]+|невыпла[${W}]+|неоплач[${W}]+)`,
  'i'
);

export function hasNegation(q: string): boolean {
  return NEGATION_RE.test(q || '');
}

// Сравнение: триггер «сравни/разниц/отлич…» И связка «и/с/от/против/vs».
const COMPARE_TRIGGER = new RegExp(`сравн[${W}]*|разниц[${W}]*|различ[${W}]*|отлич[${W}]*|противопостав[${W}]*`, 'i');
const COMPARE_CONNECTOR = /\s+(?:и|с|от|против|vs)\s+/i;

export function isCompareQuery(q: string): boolean {
  return COMPARE_TRIGGER.test(q) && COMPARE_CONNECTOR.test(q);
}

/**
 * Дописывает к поисковому запросу гипотетический параграф нормативки (HyDE).
 * Аббревиатуры/синонимы раскрывает вызывающий код (prepareSearchQuery), как в
 * Python внутри _maybe_hyde.
 */
export async function maybeHyde(query: string): Promise<string> {
  if (!RAG.useHyde) return query;
  if (query.length > RAG.hydeMaxQueryChars) return query;
  try {
    const hyde = await generateText({
      system: SYSTEM_PROMPT_HYDE,
      user: query,
      maxTokens: 120,
      temperature: 0.2,
    });
    return hyde ? `${query}\n${hyde}` : query;
  } catch {
    return query;
  }
}

async function decomposeViaLlm(query: string): Promise<string[] | null> {
  const raw = await generateText({
    system: SYSTEM_PROMPT_DECOMPOSE,
    user: query,
    maxTokens: 180,
    temperature: 0,
  });
  const parsed = extractJson(raw, '[');
  if (!Array.isArray(parsed)) return null;
  const sub = parsed
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
  return sub.length ? sub : null;
}

/**
 * Разбивает сложный вопрос на 1–N подвопросов. Сравнительные запросы
 * декомпозируются всегда — для них семантический поиск одним вектором работает
 * плохо.
 */
export async function maybeDecompose(query: string): Promise<string[]> {
  if (!(await isLlmAvailable())) return [query];

  if (isCompareQuery(query)) {
    // Принудительно декомпозируем — пусть LLM выдаст подвопросы про X и про Y.
    try {
      const sub = await decomposeViaLlm(expandAbbreviations(query));
      if (sub && sub.length >= 2) return sub.slice(0, RAG.decompositionMax);
    } catch {
      /* не получилось — идём общим путём */
    }
  }
  if (!RAG.useDecomposition) return [query];
  if (query.length < 35) return [query];
  // Дробим ТОЛЬКО реально многосоставные вопросы: раньше триггером была любая
  // запятая/«и», и одно-интентные вопросы разваливались на узкие подвопросы,
  // притягивая нерелевантные статьи (шум).
  if (!/\?[\s\S]*\?|\sа также\s|\sкроме того\s|\sи ещё\s|\sи еще\s|\sнаряду\s|перечисл/i.test(query)) {
    return [query];
  }
  try {
    const sub = await decomposeViaLlm(query);
    return sub ? sub.slice(0, RAG.decompositionMax) : [query];
  } catch {
    return [query];
  }
}

/**
 * Запрос с отрицанием переформулируем в утвердительную форму (эмбеддинги плохо
 * обрабатывают NOT) и КОНКАТЕНИРУЕМ с оригиналом: BM25 ищет по терминам
 * исходника, dense ловит семантику расширенной формы.
 */
export async function maybeRewriteQuery(query: string): Promise<string> {
  if (!hasNegation(query)) return query;
  if (!(await isLlmAvailable())) return query;
  try {
    const raw = await generateText({
      system: SYSTEM_PROMPT_QUERY_REWRITE,
      user: query,
      maxTokens: 120,
      temperature: 0,
    });
    const rewritten = (raw || '').trim().replace(/^[«"']+|[»"']+$/g, '').replace(/\.+$/, '').trim();
    if (rewritten.length >= 5) return `${query}\n${rewritten}`;
  } catch {
    /* переписывание не удалось — ищем по оригиналу */
  }
  return query;
}

/** До 3 тем запроса — для приоритизации тегов в Qdrant. */
export async function classifyTopics(query: string): Promise<string[]> {
  if (!(await isLlmAvailable())) return [];
  try {
    const raw = await generateText({
      system: SYSTEM_PROMPT_TOPIC,
      user: query,
      maxTokens: 60,
      temperature: 0,
    });
    const data = extractJson(raw) as { topics?: unknown } | null;
    const topics = data?.topics;
    if (!Array.isArray(topics)) return [];
    return topics
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** Сводит список {role, content} в краткую сводку (memory диалога). */
export async function summarizeHistory(messages: ChatMessage[]): Promise<string> {
  if (!messages.length) return '';
  if (!(await isLlmAvailable())) return '';
  const body = messages
    .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`)
    .join('\n')
    .slice(0, 6000);
  try {
    return await generateText({
      system: SYSTEM_PROMPT_SUMMARY,
      user: body,
      maxTokens: 300,
      temperature: 0,
    });
  } catch {
    return '';
  }
}

export interface FactCheck {
  supported: number;
  total: number;
  issues: string[];
}

/** Проверка соответствия ответа источникам: {supported, total, issues} или null. */
export async function selfCheck(
  question: string,
  answer: string,
  sourceTexts: string[]
): Promise<FactCheck | null> {
  if (!sourceTexts.length || !answer.trim()) return null;
  if (!(await isLlmAvailable())) return null;
  const body =
    `Вопрос: ${question}\n\n` +
    `Ответ ассистента:\n${answer}\n\n` +
    `Источники:\n${sourceTexts.slice(0, 3).map((s) => s.slice(0, 1500)).join('\n---\n')}`;
  try {
    const raw = await generateText({
      system: SYSTEM_PROMPT_SELFCHECK,
      user: body,
      maxTokens: 200,
      temperature: 0,
    });
    const data = extractJson(raw) as Record<string, unknown> | null;
    if (!data) return null;
    const issues = Array.isArray(data.issues) ? data.issues.map(String).slice(0, 5) : [];
    return {
      supported: Number.parseInt(String(data.supported ?? 0), 10) || 0,
      total: Number.parseInt(String(data.total ?? 0), 10) || 1,
      issues,
    };
  } catch {
    return null;
  }
}
