import 'server-only';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DOCS_DIR } from '@/lib/news';
import { payloadDocId, pointsCount, scrollAll } from './qdrant';
import { getBm25State, rebuildBm25 } from './bm25';

// Построение BM25-индекса из Qdrant.
//
// У Next нет "старта приложения" - маршруты поднимаются лениво. Поэтому
// индекс строится при первом поиске и дальше живёт в памяти процесса.
// Промис кэшируется, поэтому параллельные запросы ждут одну сборку,
// а не запускают N выгрузок.
//
// Чтобы первый поиск после рестарта не платил за полную выгрузку коллекции,
// результат scroll'а сохраняется на диск (docs/.cache/bm25-chunks.json).
// Валидность кэша проверяется дешёвым count() по коллекции; при недоступном
// Qdrant кэш используется как есть - лексический поиск переживает рестарт
// даже без поиска векторного. Любое изменение индекса (invalidateBm25)
// удаляет кэш.

// Санацию "призраков" и дублей здесь не делаем: точки удалённых документов
// чистит индексатор (lib/ml/indexer.ts: deleteKbDocument/переиндексация).
// Читаем то, что есть.

const MAX_CHUNKS = Math.max(1, Number(process.env.BM25_MAX_CHUNKS || 100_000));

const CACHE_FILE = path.join(DOCS_DIR, '.cache', 'bm25-chunks.json');

type Bm25Chunk = { text: string; [k: string]: unknown };

interface Bm25Cache {
  points_count: number;
  saved_at: string;
  chunks: Bm25Chunk[];
}

const g = globalThis as unknown as { __hrBm25Build?: Promise<number> };

async function readCache(): Promise<Bm25Cache | null> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as Bm25Cache;
    return Array.isArray(parsed?.chunks) ? parsed : null;
  } catch {
    return null;
  }
}

/** Снимок чанков на диск - после успешной сборки (ошибки записи не критичны). */
async function writeCache(chunks: Bm25Chunk[], count: number): Promise<void> {
  try {
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const payload: Bm25Cache = { points_count: count, saved_at: new Date().toISOString(), chunks };
    await writeFile(CACHE_FILE, JSON.stringify(payload), 'utf8');
  } catch {
    /* нет прав/места - обойдёмся без кэша */
  }
}

async function build(): Promise<number> {
  const cached = await readCache();

  // Дешёвая проверка актуальности; если Qdrant недоступен, а кэш есть -
  // строим из кэша (лучше вчерашний лексический поиск, чем никакого).
  let count: number | null = null;
  try {
    count = await pointsCount();
  } catch {
    if (cached) return rebuildBm25(cached.chunks);
    throw new Error('Qdrant недоступен, кэша BM25 нет');
  }

  if (cached && cached.points_count === count) return rebuildBm25(cached.chunks);

  const points = await scrollAll(MAX_CHUNKS);
  const chunks = points
    .filter((p) => p.payload.text)
    .map((p) => ({
      text: String(p.payload.text ?? ''),
      // Ключ `index`, а не `chunk_index`: так поле называется в payload Qdrant, и
      // retriever читает meta.index при сборке RetrievedChunk.
      index: (p.payload.chunk_index as number | null) ?? null,
      title: String(p.payload.title ?? ''),
      source_uri: String(p.payload.source_uri ?? ''),
      source_type: String(p.payload.source_type ?? ''),
      document_id: payloadDocId(p.payload),
      priority: Number(p.payload.priority ?? 2) || 2,
      chunk_id: p.id,
    }));
  await writeCache(chunks, count);
  return rebuildBm25(chunks);
}

/**
 * Гарантирует готовность BM25-индекса. Возвращает число проиндексированных
 * чанков. При недоступном Qdrant отдаёт 0 и не кэширует неудачу - следующий
 * запрос попробует снова (иначе один сбой сети выключил бы лексический поиск
 * до перезапуска процесса).
 */
export async function ensureBm25(): Promise<number> {
  if (!g.__hrBm25Build) {
    g.__hrBm25Build = build().catch((e) => {
      g.__hrBm25Build = undefined;
      throw e;
    });
  }
  try {
    return await g.__hrBm25Build;
  } catch {
    return 0;
  }
}

/** Сбрасывает индекс: следующий поиск перечитает коллекцию. */
export function invalidateBm25(): void {
  g.__hrBm25Build = undefined;
  const state = getBm25State();
  state.index = null;
  state.meta = [];
  // Индекс изменился - дисковый снимок больше не актуален.
  void rm(CACHE_FILE, { force: true }).catch(() => undefined);
}
