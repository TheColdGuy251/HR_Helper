import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Простое key-value хранилище состояния приложения в PostgreSQL (app_state).
 *
 * Нужно тем состояниям, которые раньше жили только в памяти процесса и
 * терялись при рестарте (диалоговый добор полей генерации документов).
 */

export async function stateGet<T>(key: string): Promise<T | null> {
  const row = await prisma.app_state.findUnique({ where: { key }, select: { value: true } });
  return row ? (row.value as T) : null;
}

export async function stateSet(key: string, value: unknown): Promise<void> {
  // JSON.parse(JSON.stringify()) - то же приведение, что давала запись через
  // ::jsonb: undefined-поля выпадают, Date превращается в строку.
  const parsed: unknown = JSON.parse(JSON.stringify(value ?? null));
  const json = parsed === null ? Prisma.JsonNull : (parsed as Prisma.InputJsonValue);
  await prisma.app_state.upsert({
    where: { key },
    create: { key, value: json },
    update: { value: json },
  });
}

export async function stateDelete(key: string): Promise<void> {
  await prisma.app_state.deleteMany({ where: { key } });
}
