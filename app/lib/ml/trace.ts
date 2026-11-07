import 'server-only';

/**
 * Диагностическая трассировка этапов RAG-пайплайна (spellfix -> followup ->
 * intent -> FAQ -> планировщик -> лемматизация/BM25 -> гибридный поиск -> реранк ->
 * бусты -> генерация/guard).
 *
 * Выключена по умолчанию: события пишутся только при RAG_TRACE=1 (тестовые
 * прогоны, отладка). Коллектор один на процесс - рассчитан на последовательные
 * запросы (тест-раннер); при параллельных запросах события перемешаются, для
 * прода это не предназначено.
 */

export interface TraceEvent {
  stage: string;
  data: Record<string, unknown>;
  t: number;
}

const g = globalThis as unknown as { __hrRagTrace?: { events: TraceEvent[]; t0: number } | null };

const enabled = (): boolean => process.env.RAG_TRACE === '1';

/** Начинает новый трейс (сбрасывает предыдущий). No-op без RAG_TRACE=1. */
export function traceStart(): void {
  if (!enabled()) return;
  g.__hrRagTrace = { events: [], t0: Date.now() };
}

/** Записывает событие этапа. Данные должны быть краткими (обрезайте тексты). */
export function trace(stage: string, data: Record<string, unknown> = {}): void {
  if (!enabled()) return;
  const t = g.__hrRagTrace;
  if (!t) return;
  if (t.events.length >= 200) return; // защита от разрастания
  t.events.push({ stage, data, t: Date.now() - t.t0 });
}

/** Забирает накопленный трейс (и оставляет его до следующего traceStart). */
export function traceDump(): TraceEvent[] {
  return g.__hrRagTrace?.events ?? [];
}

/** Обрезка длинных строк для событий. */
export function short(s: unknown, n = 90): string {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
