import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';

// Порт POST /api/notifications/system/read (backend/routes/notifications.py).
// Помечает ВСЕ видимые системные уведомления просмотренными: гасит бейдж,
// сами записи остаются в списке.
//
// Статический сегмент имеет приоритет над [id], поэтому этот роут перекрывает
// /api/notifications/{id}/read — как и раздельные пути в FastAPI.

export async function POST() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const reads = await prisma.notification_reads.findMany({
    where: { user_id: user.id },
    select: { notification_id: true },
  });
  const readIds = new Set(reads.map((r) => r.notification_id));

  const visible = await prisma.notifications.findMany({
    where: { OR: [{ user_id: null }, { user_id: user.id }] },
    select: { id: true },
  });

  const missing = visible
    .filter((n) => !readIds.has(n.id))
    .map((n) => ({ notification_id: n.id, user_id: user.id }));
  if (missing.length) {
    // skipDuplicates — страховка от гонки двух параллельных запросов
    // (уникальный индекс uq_notification_read).
    await prisma.notification_reads.createMany({ data: missing, skipDuplicates: true });
  }

  return NextResponse.json({ success: true });
}
