import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { isAvailable, publicKey } from '@/lib/push';

// Публичный VAPID-ключ (applicationServerKey) для подписки на Web Push.
//
// `available` означает "умеет ли сервер отправлять push": без ключей клиент
// считает push недоступным и не подписывается.

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  return NextResponse.json({ key: publicKey(), available: await isAvailable() });
}
