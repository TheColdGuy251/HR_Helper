// Считает эмбеддинги переданных фраз локальной ONNX-моделью.
//
// Нужен, чтобы сверить векторы с уже проиндексированной базой в Qdrant: при
// расхождении её пришлось бы строить заново.
//
// Использование:  node scripts/embed-probe.mjs "фраза1" "фраза2"
// Вывод: JSON-массив векторов в stdout.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Модели берём из каталога backend/models: там уже лежат нужные ONNX-файлы
env.localModelPath =
  process.env.MODELS_DIR || path.resolve(HERE, '..', '..', 'backend', 'models', 'tjs');
env.allowRemoteModels = false;
env.allowLocalModels = true;

const phrases = process.argv.slice(2);
if (!phrases.length) {
  console.error('Не переданы фразы');
  process.exit(1);
}

const extractor = await pipeline(
  'feature-extraction',
  'xenova/paraphrase-multilingual-mpnet-base-v2',
  { dtype: 'fp32' }
);

const out = [];
for (const text of phrases) {
  // sentence-transformers усредняет токены и нормирует.
  const res = await extractor(text, { pooling: 'mean', normalize: true });
  out.push(Array.from(res.data));
}
process.stdout.write(JSON.stringify(out));
