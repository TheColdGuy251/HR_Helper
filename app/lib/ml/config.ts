import 'server-only';

// Флаги продвинутых веток RAG и их значения по умолчанию (переменные RAG_* / INTENT_*).

function envBool(name: string, dflt: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  // Набор "ложных" литералов: 0/false/no/off/f/n.
  return !['0', 'false', 'no', 'off', 'f', 'n'].includes(raw.trim().toLowerCase());
}

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

export const RAG = {
  // HyDE выключен: на сильном гибриде гипотетический текст уводит в сторону.
  useHyde: envBool('RAG_USE_HYDE', false),
  hydeMaxQueryChars: envNum('RAG_HYDE_MAX_QUERY_CHARS', 80),
  useDecomposition: envBool('RAG_USE_DECOMPOSITION', true),
  decompositionMax: envNum('RAG_DECOMPOSITION_MAX', 3),
  useSelfCheck: envBool('RAG_USE_SELF_CHECK', true),
  useTopicClassify: envBool('RAG_USE_TOPIC_CLASSIFY', true),
  memoryAfterMessages: envNum('RAG_MEMORY_AFTER_MESSAGES', 6),
  memoryRecentKeep: envNum('RAG_MEMORY_RECENT_KEEP', 2),

  // Semantic-router: или-сигнал к регэксп-гейту планировщика (полноту не снижает).
  useSemanticRouter: envBool('RAG_USE_SEMANTIC_ROUTER', true),
  routerThreshold: envNum('RAG_ROUTER_THRESHOLD', 0.55),

  // GBNF-грамматика планировщика здесь не работает: llm.ts не пробрасывает
  // grammar в сессию. Флаг читаем для совместимости конфигураций; схему
  // гарантирует normalizePlan().
  plannerUseGrammar: envBool('RAG_PLANNER_USE_GRAMMAR', true),

  intentSemanticThreshold: envNum('INTENT_SEMANTIC_THRESHOLD', 0.5),
  intentSemanticMargin: envNum('INTENT_SEMANTIC_MARGIN', 0.05),
  intentUseLlm: envBool('INTENT_USE_LLM', true),

  // Перекрытие чанкера - нужно склейке "голова статьи + продолжение".
  chunkOverlap: envNum('CHUNK_OVERLAP', 100),
  rerankRrfKeep: Math.max(0, envNum('RERANK_RRF_KEEP', 3)),
} as const;

/** Косинусная близость. Векторы приходят из одного энкодера, длины совпадают. */
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return s / (Math.sqrt(na) * Math.sqrt(nb));
}
