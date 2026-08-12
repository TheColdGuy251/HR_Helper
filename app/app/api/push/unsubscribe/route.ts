import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { validationError } from '@/lib/news';

// Удаление Web Push-подписки.
// Порт POST /api/push/unsubscribe из backend/routes/push.py.
// Тело объявлено как Body(..., embed=True) → ждём {"endpoint": "..."}.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return validationError(['body'], 'json_invalid', 'JSON decode error', null);
  }
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const value = body.endpoint;
  if (typeof value !== 'string') {
    return value === undefined
      ? validationError(['body', 'endpoint'], 'missing', 'Field required', null)
      : validationError(['body', 'endpoint'], 'string_type', 'Input should be a valid string', value);
  }

  // Чужие подписки не трогаем — фильтр по user_id, как в Python.
  if (value) {
    await prisma.push_subscriptions.deleteMany({
      where: { endpoint: value, user_id: gate.user.id },
    });
  }

  return NextResponse.json({ ok: true });
}
