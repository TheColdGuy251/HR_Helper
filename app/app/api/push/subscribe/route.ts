import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, requireUser } from '@/lib/auth';
import { cut, validationError } from '@/lib/news';

// Сохранение Web Push-подписки браузера.
// Порт POST /api/push/subscribe из backend/routes/push.py.
// Тело объявлено как Body(..., embed=True) → ждём {"subscription": {...}}.

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
  const sub = body.subscription;
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
    return validationError(['body', 'subscription'], 'missing', 'Field required', null);
  }

  const subscription = sub as Record<string, unknown>;
  const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint : '';
  const keysRaw = subscription.keys;
  const keys = keysRaw && typeof keysRaw === 'object' ? (keysRaw as Record<string, unknown>) : {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys.auth === 'string' ? keys.auth : '';
  if (!endpoint || !p256dh || !auth) return badRequest('Некорректная подписка');

  const ua = typeof subscription.ua === 'string' ? subscription.ua : '';

  // endpoint уникален: один браузер — одна подписка. При повторной подписке
  // user_agent не трогаем, как и Python.
  await prisma.push_subscriptions.upsert({
    where: { endpoint },
    update: { user_id: gate.user.id, p256dh, auth },
    create: {
      user_id: gate.user.id,
      endpoint,
      p256dh,
      auth,
      user_agent: cut(ua, 400) || null,
    },
  });

  return NextResponse.json({ ok: true });
}
