import 'server-only';
import { QdrantClient } from '@qdrant/js-client-rest';
import { EMBEDDING_DIM } from './embeddings';

// Векторное хранилище: коллекция Qdrant, поля payload и индексы, по которым
// фильтрует поиск.

export interface ChunkPayload {
  /** UUID документа в kb_documents. */
  document_id: string;
  text: string;
  chunk_index?: number | null;
  title?: string;
  source_uri?: string;
  source_type?: string;
  priority?: number;
  is_archived?: boolean;
  document_kind?: string | null;
  tags?: string[];
  article_no?: number | null;
  is_article_head?: boolean;
  unit_type?: string | null;
  unit_no?: string | null;
  unit_ord?: number | null;
  is_unit_head?: boolean;
}

export interface SearchHit {
  chunk_id: string;
  score: number;
  text: string;
  document_id: string | null;
  payload: Record<string, unknown>;
}

/** UUID документа из payload точки (null - точка без документа или старого формата). */
export function payloadDocId(payload: Record<string, unknown> | null | undefined): string | null {
  const v = payload?.document_id;
  return typeof v === 'string' ? v : null;
}

// Экспортируется: планировщик правит payload точек напрямую (архивация
// документа), а имя коллекции должно быть ровно одно на весь процесс.
export const COLLECTION = process.env.QDRANT_COLLECTION || 'hr_knowledge';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

const g = globalThis as unknown as { __hrQdrant?: QdrantClient; __hrQdrantReady?: boolean };

export function qdrant(): QdrantClient {
  if (!g.__hrQdrant) {
    g.__hrQdrant = new QdrantClient({
      url: QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY || undefined,
      timeout: 30_000,
    });
  }
  return g.__hrQdrant;
}

/** Создаёт коллекцию и индексы, если их ещё нет. Идемпотентно. */
export async function ensureCollection(dim = EMBEDDING_DIM): Promise<void> {
  if (g.__hrQdrantReady) return;
  const client = qdrant();

  const { collections } = await client.getCollections();
  if (!collections.some((c) => c.name === COLLECTION)) {
    await client.createCollection(COLLECTION, {
      vectors: { size: dim, distance: 'Cosine' },
      // Скалярная квантизация - вчетверо меньше памяти при близком качестве.
      quantization_config: { scalar: { type: 'int8', always_ram: true } },
      hnsw_config: { m: 16, ef_construct: 128 },
    });
  }

  // Индексы payload создаются и для существующей коллекции: повторный вызов
  // на уже проиндексированном поле ничего не делает.
  const indexes: [string, 'uuid' | 'keyword' | 'float' | 'bool'][] = [
    ['document_id', 'uuid'],
    ['source_type', 'keyword'],
    ['article_no', 'float'],
    ['is_article_head', 'bool'],
    ['unit_type', 'keyword'],
    ['unit_no', 'keyword'],
    ['unit_ord', 'float'],
    ['is_unit_head', 'bool'],
  ];
  for (const [field, schema] of indexes) {
    try {
      await client.createPayloadIndex(COLLECTION, { field_name: field, field_schema: schema });
    } catch {
      /* индекс уже есть */
    }
  }
  g.__hrQdrantReady = true;
}

// Qdrant не принимает HTTP-тело больше 32 МБ: 768-мерные векторы упираются в
// лимит уже на ~1300 чанках, поэтому пишем партиями.
const UPSERT_BATCH = 200;

export async function upsertChunks(
  documentId: string,
  chunks: (Partial<ChunkPayload> & { text: string; index?: number })[],
  vectors: number[][]
): Promise<string[]> {
  await ensureCollection();
  const client = qdrant();

  const points = chunks.map((chunk, i) => ({
    id: crypto.randomUUID().replace(/-/g, ''),
    vector: vectors[i],
    payload: {
      document_id: documentId,
      text: chunk.text,
      chunk_index: chunk.index ?? chunk.chunk_index ?? null,
      title: chunk.title ?? '',
      source_uri: chunk.source_uri ?? '',
      source_type: chunk.source_type ?? 'local',
      priority: Number(chunk.priority ?? 2) || 2,
      is_archived: Boolean(chunk.is_archived),
      document_kind: chunk.document_kind ?? null,
      tags: chunk.tags ?? [],
      article_no: chunk.article_no ?? null,
      is_article_head: Boolean(chunk.is_article_head),
      unit_type: chunk.unit_type ?? null,
      unit_no: chunk.unit_no ?? null,
      unit_ord: chunk.unit_ord ?? null,
      is_unit_head: Boolean(chunk.is_unit_head),
    },
  }));

  for (let i = 0; i < points.length; i += UPSERT_BATCH) {
    await client.upsert(COLLECTION, { points: points.slice(i, i + UPSERT_BATCH), wait: true });
  }
  return points.map((p) => p.id);
}

type Condition = { key: string; match: { value: string | number | boolean } };

export async function search(
  queryVector: number[],
  {
    topK = 20,
    filters,
    includeArchived = false,
    tagsAny,
  }: {
    topK?: number;
    filters?: Record<string, string | number | boolean>;
    includeArchived?: boolean;
    tagsAny?: string[];
  } = {}
): Promise<SearchHit[]> {
  await ensureCollection();
  const client = qdrant();

  const must: Condition[] = Object.entries(filters || {}).map(([key, value]) => ({
    key,
    match: { value },
  }));
  // Архивные редакции по умолчанию вне поиска.
  const mustNot: Condition[] = includeArchived
    ? []
    : [{ key: 'is_archived', match: { value: true } }];

  const buildFilter = (withTags: boolean) => {
    const should = withTags && tagsAny?.length
      ? tagsAny.map((t) => ({ key: 'tags', match: { value: t } }))
      : undefined;
    if (!must.length && !mustNot.length && !should) return undefined;
    return { must, must_not: mustNot, ...(should ? { should } : {}) };
  };

  const run = async (withTags: boolean) =>
    client.query(COLLECTION, {
      query: queryVector,
      limit: topK,
      filter: buildFilter(withTags),
      with_payload: true,
    });

  let res = await run(true);

  // Qdrant трактует `should` без жёсткого `must` как фильтр, а не как усиление:
  // документ без нужного тега просто не вернётся. Повторяем без тегов, чтобы
  // не отдать пустой результат при непустой коллекции.
  if (!res.points.length && tagsAny?.length) {
    res = await run(false);
  }

  return res.points.map((p) => {
    const payload = (p.payload || {}) as Record<string, unknown>;
    return {
      chunk_id: String(p.id),
      score: p.score ?? 0,
      text: String(payload.text ?? ''),
      document_id: typeof payload.document_id === 'string' ? payload.document_id : null,
      payload,
    };
  });
}

/** Обновляет payload-поля у всех чанков документа без переиндексации. */
export async function setDocumentPayload(
  documentId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await ensureCollection();
  await qdrant().setPayload(COLLECTION, {
    payload,
    filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
    wait: true,
  });
}

/** Удаляет все чанки документа (используется при переиндексации и удалении). */
export async function deleteDocument(documentId: string): Promise<void> {
  await ensureCollection();
  await qdrant().delete(COLLECTION, {
    filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
    wait: true,
  });
}

/** Число точек коллекции - дешёвая проверка актуальности BM25-кэша. */
export async function pointsCount(): Promise<number> {
  await ensureCollection();
  const res = await qdrant().count(COLLECTION, { exact: true });
  return res.count;
}

/** Выгружает чанки по фильтру - нужно для построения BM25-индекса. */
export async function scrollAll(
  limit = 10_000
): Promise<{ id: string; payload: Record<string, unknown> }[]> {
  await ensureCollection();
  const client = qdrant();
  const out: { id: string; payload: Record<string, unknown> }[] = [];
  let offset: string | number | undefined | null = undefined;

  while (out.length < limit) {
    const res = await client.scroll(COLLECTION, {
      limit: Math.min(1000, limit - out.length),
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: false,
    });
    for (const p of res.points) {
      out.push({ id: String(p.id), payload: (p.payload || {}) as Record<string, unknown> });
    }
    offset = res.next_page_offset as string | number | null | undefined;
    if (!offset) break;
  }
  return out;
}
