import 'server-only';
import path from 'node:path';

// Кросс-энкодер для переупорядочивания результатов поиска.
// Порт services/rag/reranker.py: та же модель jina-reranker-v2-base-multilingual,
// ONNX-файл которой уже скачан бэкендом и переиспользуется.
//
// Модель только мультиязычная: англоязычный фолбэк на русских текстах работает
// хуже, чем отсутствие реранка вовсе (портит порядок, полученный RRF). Поэтому
// при неудачной загрузке возвращаем исходный порядок, а не пробуем другую.

const MODEL_ID = 'jinaai/jina-reranker-v2-base-multilingual';

function modelsDir(): string {
  return process.env.MODELS_DIR || path.resolve(process.cwd(), '..', 'backend', 'models', 'tjs');
}

type Ranker = {
  tokenizer: (
    texts: string[],
    pairs: string[],
    opts: Record<string, unknown>
  ) => Record<string, unknown>;
  model: (inputs: Record<string, unknown>) => Promise<{ logits: { data: Float32Array } }>;
};

const g = globalThis as unknown as { __hrReranker?: Promise<Ranker | null> };

async function getRanker(): Promise<Ranker | null> {
  if (!g.__hrReranker) {
    g.__hrReranker = (async () => {
      try {
        const { env, AutoTokenizer, AutoModelForSequenceClassification } = await import(
          '@huggingface/transformers'
        );
        env.localModelPath = modelsDir();
        env.allowRemoteModels = false;
        env.allowLocalModels = true;

        const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
        const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, {
          dtype: 'fp32',
        });
        return {
          tokenizer: (texts: string[], pairs: string[], opts: Record<string, unknown>) =>
            (tokenizer as unknown as (a: string[], b: string[], c: Record<string, unknown>) => Record<string, unknown>)(
              texts,
              pairs,
              opts
            ),
          model: (inputs: Record<string, unknown>) =>
            (model as unknown as (i: Record<string, unknown>) => Promise<{ logits: { data: Float32Array } }>)(
              inputs
            ),
        };
      } catch {
        return null; // останемся на порядке RRF
      }
    })();
  }
  return g.__hrReranker;
}

/**
 * Переупорядочивает документы по релевантности запросу и возвращает первые topN.
 * Если модель недоступна, отдаёт исходный порядок — так же поступает Python.
 */
export async function rerank<T extends { text: string }>(
  query: string,
  chunks: T[],
  topN = Number(process.env.RERANK_TOP_N || 5)
): Promise<T[]> {
  if (!chunks.length) return [];

  const ranker = await getRanker();
  if (!ranker) return chunks.slice(0, topN);

  try {
    const inputs = ranker.tokenizer(
      chunks.map(() => query),
      chunks.map((c) => c.text),
      { padding: true, truncation: true }
    );
    const { logits } = await ranker.model(inputs);
    const scores = Array.from(logits.data);

    return chunks
      .map((chunk, i) => ({ chunk, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map((x) => x.chunk);
  } catch {
    return chunks.slice(0, topN);
  }
}
