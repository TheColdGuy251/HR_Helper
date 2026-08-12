import 'server-only';
import { qdrant } from './qdrant';
import { hitToChunk, type RetrievedChunk } from './retriever';

// Выборки из Qdrant, нужные структурным режимам планировщика.
// Порт методов QdrantStore, которых не было в первом заходе:
// fetch_article_heads, fetch_unit_heads, fetch_chunks_by_unit,
// fetch_chunks_by_text_prefix, fetch_document_chunks.
// (fetch_chunks_by_article_no уже живёт в retriever.ts.)

// Название коллекции продублировано из qdrant.ts (там оно приватное).
// Значения по умолчанию совпадают, переопределяются одной переменной окружения.
const COLLECTION = process.env.QDRANT_COLLECTION || 'hr_knowledge';

type Cond =
  | { key: string; match: { value: string | number | boolean } }
  | { key: string; range: { gte: number; lte: number } };

type Point = { id: string | number; payload?: Record<string, unknown> | null };

function chunkIndexOf(p: Point): number {
  const v = (p.payload || {}).chunk_index;
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toChunk(p: Point): RetrievedChunk {
  const payload = (p.payload || {}) as Record<string, unknown>;
  return hitToChunk({
    chunk_id: String(p.id),
    score: 1.0,
    text: String(payload.text ?? ''),
    document_id: (payload.document_id as number | null) ?? null,
    payload,
  });
}

/** Полный проход по фильтру (Qdrant отдаёт страницами по next_page_offset). */
async function scrollAllWhere(must: Cond[] | null, pageSize = 512): Promise<Point[]> {
  const client = qdrant();
  const out: Point[] = [];
  let offset: string | number | undefined | null;
  for (;;) {
    const res = await client.scroll(COLLECTION, {
      ...(must?.length ? { filter: { must } } : {}),
      limit: pageSize,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: false,
    });
    out.push(...(res.points as unknown as Point[]));
    offset = res.next_page_offset as string | number | null | undefined;
    if (!offset) break;
  }
  return out;
}

/**
 * (article_no, document_id) по всем заголовкам статей, отсортированные по
 * номеру. Компактно (только головы статей) и по индексу — для режимов
 * «первая/последняя/первые N/сколько».
 */
export async function fetchArticleHeads(
  documentId: number | null = null
): Promise<[number, number | null][]> {
  const must: Cond[] = [{ key: 'is_article_head', match: { value: true } }];
  if (documentId !== null) must.push({ key: 'document_id', match: { value: documentId } });

  const out: [number, number | null][] = [];
  for (const p of await scrollAllWhere(must)) {
    const pay = p.payload || {};
    if (pay.article_no === null || pay.article_no === undefined) continue;
    const no = Number(pay.article_no);
    if (Number.isFinite(no)) out.push([no, (pay.document_id as number | null) ?? null]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Заголовки единиц данного типа: (unit_no, unit_ord, document_id) по unit_ord.
 * Для extreme/range/count по разделам, главам, пунктам, параграфам.
 */
export async function fetchUnitHeads(
  unitType: string,
  documentId: number | null = null
): Promise<[string, number, number | null][]> {
  const must: Cond[] = [
    { key: 'unit_type', match: { value: unitType } },
    { key: 'is_unit_head', match: { value: true } },
  ];
  if (documentId !== null) must.push({ key: 'document_id', match: { value: documentId } });

  const out: [string, number, number | null][] = [];
  for (const p of await scrollAllWhere(must)) {
    const pay = p.payload || {};
    if (pay.unit_no === null || pay.unit_no === undefined) continue;
    const ord = Number(pay.unit_ord ?? 0);
    out.push([
      String(pay.unit_no),
      Number.isFinite(ord) ? ord : 0,
      (pay.document_id as number | null) ?? null,
    ]);
  }
  return out.sort((a, b) => a[1] - b[1]);
}

/** Все чанки структурной единицы (раздел/глава/пункт N) по индексам unit_type+unit_no. */
export async function fetchChunksByUnit(
  unitType: string,
  unitNo: string,
  documentId: number | null = null,
  limit = 8
): Promise<RetrievedChunk[]> {
  const must: Cond[] = [
    { key: 'unit_type', match: { value: unitType } },
    { key: 'unit_no', match: { value: unitNo } },
  ];
  if (documentId !== null) must.push({ key: 'document_id', match: { value: documentId } });

  const res = await qdrant().scroll(COLLECTION, {
    filter: { must },
    limit: Math.max(limit, 64),
    with_payload: true,
    with_vector: false,
  });
  return (res.points as unknown as Point[])
    .sort((a, b) => chunkIndexOf(a) - chunkIndexOf(b))
    .slice(0, limit)
    .map(toChunk);
}

/**
 * Чанки, чей текст начинается с prefixLower (регистронезависимо) — точный
 * поиск «Статья N.» по старым данным без article_no. Сканирует коллекцию.
 *
 * digitBoundary требует, чтобы сразу после префикса НЕ шла цифра или «.цифра»:
 * иначе «статья 28» матчит и «Статья 280», и «Статья 28.1», а в контекст
 * уезжают чужие статьи и модель отказывается цитировать нужную.
 */
export async function fetchChunksByTextPrefix(
  prefixLower: string,
  limit = 5,
  digitBoundary = false
): Promise<RetrievedChunk[]> {
  const points = await scrollAllWhere(null);

  const boundaryOk = (txtLower: string): boolean => {
    if (!digitBoundary) return true;
    const tail = txtLower.slice(prefixLower.length);
    if (/^\d/.test(tail)) return false; // «статья 28» × «статья 280»
    if (/^\.\d/.test(tail)) return false; // «статья 28» × «статья 28.1»
    return true;
  };

  const hits: Point[] = [];
  for (const p of points) {
    const txt = String((p.payload || {}).text ?? '').replace(/^\s+/, '');
    const low = txt.toLowerCase();
    if (low.startsWith(prefixLower) && boundaryOk(low)) {
      hits.push({ id: p.id, payload: { ...(p.payload || {}), text: txt } });
    }
  }
  return hits
    .sort((a, b) => chunkIndexOf(a) - chunkIndexOf(b))
    .slice(0, limit)
    .map(toChunk);
}

/**
 * Первые/последние N чанков документа В ПОРЯДКЕ chunk_index — «каталожный»
 * фолбэк для range, когда у чанков нет метаданных статей.
 */
export async function fetchDocumentChunks(
  documentId: number,
  limit = 5,
  order: 'asc' | 'desc' = 'asc'
): Promise<RetrievedChunk[]> {
  const points = await scrollAllWhere([{ key: 'document_id', match: { value: documentId } }]);
  points.sort((a, b) =>
    order === 'desc' ? chunkIndexOf(b) - chunkIndexOf(a) : chunkIndexOf(a) - chunkIndexOf(b)
  );
  return points.slice(0, limit).map(toChunk);
}
