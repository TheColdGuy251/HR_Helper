import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, userJson, verifyPassword, withSession } from '@/lib/auth';
import type { CurrentUser } from '@/lib/auth';

// Вход по логину или корпоративной почте.
// Порт POST /api/auth/login из backend/routes/auth.py (api_login).

export async function POST(request: NextRequest) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest('Ожидается JSON с полями username и password');
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) {
    return badRequest('Укажите логин и пароль');
  }

  // Ищем по логину или почте; если ввели «ivanov@tyuiu.ru», а в БД логин
  // «ivanov» — пробуем локальную часть адреса (как в бэкенде).
  let user = await prisma.users.findFirst({
    where: { OR: [{ username }, { email: username }] },
  });
  if (!user && username.includes('@')) {
    user = await prisma.users.findFirst({ where: { username: username.split('@', 1)[0] } });
  }

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return NextResponse.json({ detail: 'Неверный логин или пароль' }, { status: 401 });
  }
  if (!user.is_active) {
    return NextResponse.json({ detail: 'Учётная запись отключена' }, { status: 403 });
  }

  return withSession(
    NextResponse.json({ success: true, user: userJson(user as CurrentUser) }),
    user.id
  );
}
