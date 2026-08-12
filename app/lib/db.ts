import 'server-only';
import { PrismaClient } from '@prisma/client';

// Одно подключение к БД на процесс. В dev-режиме Next перезагружает модули,
// поэтому клиент кладём в globalThis — иначе каждый hot-reload открывал бы
// новый пул соединений к PostgreSQL.

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// ── Утилиты ────────────────────────────────────────────────────────────────

/**
 * Сериализация даты для API: ISO-8601 в UTC с суффиксом "Z".
 * В базе лежит UTC, метка зоны обязательна — без неё браузер разбирает строку
 * как локальное время и «время назад» промахивается на величину пояса.
 */
export function isoUtc(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString(); // 2026-07-27T05:25:27.123Z
}

/** Экранирование значения для LIKE/ILIKE (символы % и _). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
