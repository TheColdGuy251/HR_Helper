import 'server-only';
import { PrismaClient } from '@prisma/client';

// Одно подключение к БД на процесс. В dev-режиме Next перезагружает модули,
// поэтому клиент кладём в globalThis - иначе каждый hot-reload открывал бы
// новый пул соединений к PostgreSQL.

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Утилиты

/**
 * Время для ответа API: ISO 8601 в UTC с явной зоной ("2026-07-27T05:25:27.123Z").
 *
 * В БД время хранится как timestamptz; суффикс Z нужен, чтобы браузер не
 * принял время за локальное и не ошибся на величину часового пояса.
 */
export function isoUtc(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Экранирование значения для LIKE/ILIKE (символы % и _). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
