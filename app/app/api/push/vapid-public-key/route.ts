import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { isAvailable, publicKey } from '@/lib/push';

// Публичный VAPID-ключ (applicationServerKey) для подписки на Web Push.
// Порт GET /api/push/vapid-public-key из backend/routes/push.py.
//
// Раньше маршрут намеренно уходил в FastAPI: `available` означает «умеет ли
// бэкенд ОТПРАВЛЯТЬ push», а Next только сохранял подписки. Теперь отправка
// есть и здесь (lib/push), поэтому отвечаем сами — иначе при выключенном
// Python клиент считал бы push недоступным и не подписывался вовсе.

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  return NextResponse.json({ key: publicKey(), available: await isAvailable() });
}
