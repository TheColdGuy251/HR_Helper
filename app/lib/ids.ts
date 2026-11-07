// Идентификаторы записей - UUIDv7 (см. prisma/schema.prisma). Модуль без
// 'server-only': сравнивать id приходится и в браузере.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Строка в каноническом виде UUID. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** UUID из произвольного значения (тела запроса, параметра) либо null. */
export function asUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return UUID_RE.test(v) ? v : null;
}

/**
 * Порядок записей по id. UUIDv7 начинается с метки времени, поэтому
 * лексикографическое сравнение совпадает с порядком создания.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Короткая метка id для показа в таблицах. Берём хвост: начало UUIDv7 - метка
 * времени, у записей, созданных подряд, оно совпадает.
 */
export function shortId(id: string): string {
  return id.slice(-8);
}
