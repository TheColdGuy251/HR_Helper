import { NextResponse } from 'next/server';
import { currentUser, userJson } from '@/lib/auth';

// Текущий пользователь.
// Без сессии отвечает 401 и {"user": null} - фронтенд на это опирается.

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({ user: userJson(user) });
}
