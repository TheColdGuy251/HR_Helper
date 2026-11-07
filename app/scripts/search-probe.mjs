// Проверка поиска: эмбеддер -> Qdrant -> результаты. Помогает убедиться, что
// изменения в поиске не сломали релевантность.
//
// Использование: node scripts/search-probe.mjs "запрос"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { QdrantClient } from '@qdrant/js-client-rest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
env.localModelPath =
  process.env.MODELS_DIR || path.resolve(HERE, '..', '..', 'backend', 'models', 'tjs');
env.allowRemoteModels = false;
env.allowLocalModels = true;

const query = process.argv[2] || 'отпуск по беременности и родам';
const COLLECTION = process.env.QDRANT_COLLECTION || 'hr_knowledge';

const extractor = await pipeline(
  'feature-extraction',
  'xenova/paraphrase-multilingual-mpnet-base-v2',
  { dtype: 'fp32' }
);
const emb = await extractor(query, { pooling: 'mean', normalize: true });
const vector = Array.from(emb.data);

const client = new QdrantClient({
  url: process.env.QDRANT_URL || 'http://localhost:6333',
  timeout: 30_000,
});

const res = await client.query(COLLECTION, {
  query: vector,
  limit: 5,
  filter: { must: [], must_not: [{ key: 'is_archived', match: { value: true } }] },
  with_payload: true,
});

console.log(`Запрос: ${query}`);
console.log(`Найдено: ${res.points.length}\n`);
for (const p of res.points) {
  const pl = p.payload || {};
  const text = String(pl.text || '').replace(/\s+/g, ' ').slice(0, 110);
  console.log(`  score=${p.score.toFixed(4)}  «${pl.title}»`);
  console.log(`    ${text}…\n`);
}
