import 'server-only';
import { generateText, isLlmAvailable } from './llm';

// Структурированная генерация JSON.
//
// Режим один - "попроси JSON и разбери ответ": схему подсказываем в промпте, а
// результат достаём брекет-сканнером и валидируем на стороне вызывающего кода
// (normalizePlan и т.п.). GBNF-грамматика и response_format не используются:
// llm.ts не пробрасывает эти опции в сессию.

const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
const FENCE_RE = /```(?:json)?/gi;

/**
 * Вырезает первый сбалансированный JSON-объект (или массив) из текста.
 * Модель любит добавлять преамбулу и ```-заборы - плоский `JSON.parse` на них
 * падает, а "первая { ... последняя }" ломается на вложенных объектах.
 */
export function extractJson(raw: string, open: '{' | '[' = '{'): unknown {
  const close = open === '{' ? '}' : ']';
  const text = (raw || '').replace(THINK_RE, '').replace(FENCE_RE, '');
  const start = text.indexOf(open);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Потолок ответа берём из настроек (LLM_MAX_TOKENS).
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 2048);

/**
 * JSON-ответ модели или null. null означает "модель недоступна либо ответила
 * не-JSON" - вызывающий код обязан безопасно деградировать при
 * `{"_mock": true}`.
 */
export async function generateJson(
  system: string,
  user: string,
  schemaHint: string,
  maxTokens = MAX_TOKENS,
  userId: string | null = null
): Promise<Record<string, unknown> | null> {
  // Без модели llm.ts вернул бы текст-заглушку - не тратим на него разбор.
  if (!(await isLlmAvailable())) return null;
  const raw = await generateText({
    system,
    user: `${user}\n\nСхема ответа (строго JSON):\n${schemaHint}`,
    temperature: 0,
    maxTokens,
    userId,
  });
  const data = extractJson(raw);
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * То же самое, но всегда возвращает объект; признак "модель не отвечала" -
 * ключ `_mock`. По нему отличают заглушку от настоящего пустого разбора.
 */
export async function generateJsonOrMock(
  system: string,
  user: string,
  schemaHint: string,
  userId: string | null = null
): Promise<Record<string, unknown>> {
  if (!(await isLlmAvailable())) {
    return { _mock: true, _note: 'LLM недоступна, возвращён пустой объект' };
  }
  return (await generateJson(system, user, schemaHint, MAX_TOKENS, userId)) ?? {};
}
