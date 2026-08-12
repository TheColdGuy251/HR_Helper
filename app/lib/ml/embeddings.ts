import 'server-only';
import path from 'node:path';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

// Эмбеддер: та же ONNX-модель, что использует Python (FastEmbed берёт сборки
// xenova — автора Transformers.js), поэтому векторы совпадают по направлению
// и уже проиндексированная коллекция Qdrant остаётся валидной.
//
// Разница только в длине вектора: Python отдаёт ненормированный, здесь —
// единичный. Для метрики Cosine это безразлично, Qdrant нормирует сам.

const MODEL_ID = 'xenova/paraphrase-multilingual-mpnet-base-v2';

// Модели лежат в каталоге бэкенда: они уже скачаны (1.1 ГБ) и переиспользуются,
// чтобы не тянуть второй раз. MODELS_DIR позволяет переопределить путь.
function modelsDir(): string {
  return process.env.MODELS_DIR || path.resolve(process.cwd(), '..', 'backend', 'models', 'tjs');
}

type Extractor = FeatureExtractionPipeline;

// Устройство эмбеддера. По умолчанию CPU — как FastEmbed в Python, и по той же
// причине: видеопамять целиком нужна llama.cpp. Если onnxruntime успевает
// захватить CUDA раньше загрузки модели, та падает с CUDA error и роняет
// процесс. Переопределяется через EMBEDDINGS_DEVICE (например, 'cuda') — но
// тогда следите за объёмом VRAM и уменьшайте LLM_N_GPU_LAYERS.
const DEVICE = (process.env.EMBEDDINGS_DEVICE || 'cpu') as 'cpu' | 'cuda' | 'auto';

// Загрузка модели занимает секунды и сотни мегабайт — держим один экземпляр на
// процесс. globalThis нужен из-за hot-reload в dev: иначе модель грузилась бы
// заново при каждом изменении файла.
const g = globalThis as unknown as { __hrEmbedder?: Promise<Extractor> };

async function getExtractor(): Promise<Extractor> {
  if (!g.__hrEmbedder) {
    g.__hrEmbedder = (async () => {
      // ПОРЯДОК ВАЖЕН: llama.cpp (CUDA) должен инициализироваться и сделать
      // первую генерацию ДО загрузки onnxruntime, иначе процесс падает с
      // «ggml-cuda.cu:106: CUDA error» — подробности в warmupLlm().
      const { warmupLlm } = await import('./llm');
      await warmupLlm();
      const { env, pipeline } = await import('@huggingface/transformers');
      env.localModelPath = modelsDir();
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      return (await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'fp32',
        device: DEVICE,
      })) as Extractor;
    })();
  }
  return g.__hrEmbedder;
}

/** Размерность вектора модели (совпадает с размером коллекции в Qdrant). */
export const EMBEDDING_DIM = 768;

/**
 * Векторизует тексты. `isQuery` оставлен для совместимости с бэкендом: у
 * e5-моделей запрос и документ кодируются с разными префиксами, у текущей
 * mpnet-модели разницы нет.
 */
export async function embed(texts: string[], isQuery = false): Promise<number[][]> {
  if (!texts.length) return [];
  const extractor = await getExtractor();

  const prefixed = MODEL_ID.toLowerCase().includes('e5')
    ? texts.map((t) => (isQuery ? `query: ${t}` : `passage: ${t}`))
    : texts;

  const out: number[][] = [];
  // Батчим, чтобы не держать в памяти сразу весь корпус при индексации.
  const BATCH = 16;
  for (let i = 0; i < prefixed.length; i += BATCH) {
    const chunk = prefixed.slice(i, i + BATCH);
    const res = await extractor(chunk, { pooling: 'mean', normalize: true });
    const dims = res.dims as number[];
    const data = res.data as Float32Array;
    const width = dims[dims.length - 1];
    for (let r = 0; r < chunk.length; r++) {
      out.push(Array.from(data.slice(r * width, (r + 1) * width)));
    }
  }
  return out;
}

export async function embedOne(text: string, isQuery = false): Promise<number[]> {
  return (await embed([text], isQuery))[0];
}
