import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isJobName, JOB_NAMES, runJob } from '@/lib/scheduler';

// Внешняя точка запуска фоновых джобов (планировщик из
// backend/services/tasks/scheduler.py). Своего демона в Next.js нет, поэтому
// «тикает» кто-то снаружи: scripts/worker.mjs рядом с `next start` либо
// Планировщик заданий Windows / cron.
//
// Джоб выполняется ВНУТРИ процесса Next — это и есть смысл HTTP-точки: только
// здесь доступны шина SSE (подписчики живут в памяти процесса), общий пул
// Prisma и общий замок индексации.

type Ctx = { params: Promise<{ job: string }> };

/** Сравнение секретов без утечки времени (в т.ч. по длине). */
function secretMatches(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const expected = (process.env.CRON_SECRET || '').trim();
  // Без секрета эндпоинт был бы открытым спусковым крючком для удаления данных
  // (джоб ПДн), поэтому не «пропускаем проверку», а выключаем маршрут целиком.
  if (!expected) {
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET не задан — запуск джобов отключён' },
      { status: 503 }
    );
  }

  const header = request.headers.get('x-cron-secret') || '';
  const auth = request.headers.get('authorization') || '';
  const given = header || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!given || !secretMatches(given, expected)) {
    return NextResponse.json({ success: false, error: 'Неверный секрет' }, { status: 401 });
  }

  const job = (await params).job;
  if (!isJobName(job)) {
    return NextResponse.json(
      { success: false, error: `Неизвестный джоб: ${job}`, jobs: JOB_NAMES },
      { status: 404 }
    );
  }

  const result = await runJob(job);
  return NextResponse.json({ success: result.ok, job, ...result });
}
