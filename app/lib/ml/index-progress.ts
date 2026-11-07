import 'server-only';

/**
 * Живой прогресс индексации документов БЗ. Держится в памяти процесса
 * (индексация идёт в этом же процессе,
 * см. after() в app/api/kb/upload), отдаётся списком GET /api/kb/documents и
 * рисуется прогресс-баром в /kb (components/kb/docs-tab.tsx).
 */

export interface DocProgress {
  /** Человекочитаемая стадия: "разбор файла", "векторизация 3/12"... */
  label: string;
  /** Сделано/всего в текущей стадии (для векторизации - батчи чанков). */
  done: number;
  total: number;
  /** Общий процент 0-100 по всему конвейеру. */
  percent: number;
}

const g = globalThis as unknown as { __hrIndexProgress?: Map<string, DocProgress> };

function map(): Map<string, DocProgress> {
  if (!g.__hrIndexProgress) g.__hrIndexProgress = new Map();
  return g.__hrIndexProgress;
}

export function setIndexProgress(docId: string, label: string, percent: number, done = 0, total = 0): void {
  map().set(docId, { label, done, total, percent: Math.max(0, Math.min(100, Math.round(percent))) });
}

export function clearIndexProgress(docId: string): void {
  map().delete(docId);
}

export function getIndexProgress(docId: string): DocProgress | null {
  return map().get(docId) ?? null;
}
