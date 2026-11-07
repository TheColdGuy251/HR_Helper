// Перевод Qdrant на UUID документов - шаг 4 из scripts/migrate-legacy-db.sql.
//
//   node scripts/migrate-legacy-qdrant.mjs
//
// 1. В payload каждой точки document_id (int) заменяется на новый UUID
//    документа - по таблице legacy.map_kb_documents. Векторы не трогаются,
//    переиндексация не нужна.
// 2. Индекс payload по document_id пересоздаётся с типа integer на uuid.
// 3. Удаляются кэши на диске со старыми id: снимок BM25 (сверяется только по
//    числу точек, а оно не изменилось) и превью шаблонов (<id>.docx).
//
// Повторный запуск безопасен: точки, уже переведённые на UUID, числовым
// фильтром не находятся.

import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION = process.env.QDRANT_COLLECTION || 'hr_knowledge';
const DOCS_DIR = path.resolve(process.env.BACKEND_DIR || path.join(process.cwd(), '..', 'backend'), 'docs');

async function qdrant(method, url, body) {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
  return json.result;
}

const prisma = new PrismaClient();
try {
  const map = await prisma.$queryRawUnsafe(
    'SELECT old_id::int AS old_id, new_id::text AS new_id FROM legacy.map_kb_documents ORDER BY old_id'
  );

  let moved = 0;
  for (const { old_id: oldId, new_id: newId } of map) {
    const filter = { must: [{ key: 'document_id', match: { value: oldId } }] };
    const { count } = await qdrant('POST', '/points/count', { filter, exact: true });
    if (!count) continue;
    await qdrant('POST', '/points/payload?wait=true', { payload: { document_id: newId }, filter });
    moved += count;
    console.log(`документ ${oldId} → ${newId}: ${count} фрагм.`);
  }
  console.log(`Переведено точек: ${moved}`);

  // Проверка: у всех точек document_id - строка UUID.
  let offset = null;
  let total = 0;
  let stale = 0;
  do {
    const page = await qdrant('POST', '/points/scroll', {
      limit: 1000,
      with_payload: ['document_id'],
      with_vector: false,
      ...(offset !== null ? { offset } : {}),
    });
    for (const p of page.points) {
      total += 1;
      if (typeof p.payload?.document_id !== 'string') stale += 1;
    }
    offset = page.next_page_offset ?? null;
  } while (offset !== null);
  console.log(`Всего точек: ${total}, с числовым document_id: ${stale}`);
  if (stale) throw new Error('Не все точки переведены — индекс не пересоздаю');

  // Индекс payload: integer -> uuid. Удаление несуществующего индекса - не ошибка.
  await qdrant('DELETE', '/index/document_id?wait=true').catch(() => undefined);
  await qdrant('PUT', '/index?wait=true', { field_name: 'document_id', field_schema: 'uuid' });
  console.log('Индекс document_id: uuid');

  await rm(path.join(DOCS_DIR, '.cache', 'bm25-chunks.json'), { force: true });
  const previews = path.join(DOCS_DIR, 'templates', '.previews');
  const names = await readdir(previews).catch(() => []);
  for (const name of names.filter((n) => /^\d+\.docx$/.test(n))) {
    await rm(path.join(previews, name), { force: true });
  }
  console.log(`Кэши со старыми id удалены (превью шаблонов: ${names.filter((n) => /^\d+\.docx$/.test(n)).length})`);
} finally {
  await prisma.$disconnect();
}
