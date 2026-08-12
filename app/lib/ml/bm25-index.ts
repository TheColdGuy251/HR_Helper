import 'server-only';
import { scrollAll } from './qdrant';
import { getBm25State, rebuildBm25 } from './bm25';

// Построение BM25-индекса из Qdrant. Порт RAGIndexer.rebuild_bm25_index()
// (services/rag/indexer.py): payload-выгрузка через scroll и полная
// перестройка индекса в памяти процесса.
//
// Отличие от Python в МОМЕНТЕ построения: FastAPI строит индекс на старте
// приложения, у Next «старта» нет — маршруты поднимаются лениво. Поэтому
// индекс строится при первом поиске и дальше живёт в памяти процесса; первый
// запрос после рестарта платит за выгрузку коллекции (секунды), остальные —
// нет. Промис кэшируется, поэтому параллельные запросы ждут одну сборку,
// а не запускают N выгрузок.

// Санацию «призраков» и дублей здесь не делаем: точки удалённых документов
// чистит индексатор (lib/ml/indexer.ts: deleteKbDocument/переиндексация).
// Читаем то, что есть.

const MAX_CHUNKS = Math.max(1, Number(process.env.BM25_MAX_CHUNKS || 100_000));

const g = globalThis as unknown as { __hrBm25Build?: Promise<number> };

async function build(): Promise<number> {
  const points = await scrollAll(MAX_CHUNKS);
  const chunks = points
    .filter((p) => p.payload.text)
    .map((p) => ({
      text: String(p.payload.text ?? ''),
      // Ключ `index`, а не `chunk_index`: именно так называет поле Python,
      // и retriever читает meta.index при сборке RetrievedChunk.
      index: (p.payload.chunk_index as number | null) ?? null,
      title: String(p.payload.title ?? ''),
      source_uri: String(p.payload.source_uri ?? ''),
      source_type: String(p.payload.source_type ?? ''),
      document_id: (p.payload.document_id as number | null) ?? null,
      priority: Number(p.payload.priority ?? 2) || 2,
      chunk_id: p.id,
    }));
  return rebuildBm25(chunks);
}

/**
 * Гарантирует готовность BM25-индекса. Возвращает число проиндексированных
 * чанков. При недоступном Qdrant отдаёт 0 и НЕ кэширует неудачу — следующий
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
}
