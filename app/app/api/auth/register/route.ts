import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { badRequest, hashPassword, userJson, withSession } from '@/lib/auth';
import type { CurrentUser } from '@/lib/auth';

// Регистрация. Порт POST /api/auth/register из backend/routes/auth.py.
// Ограничения полей повторяют RegisterForm (backend/forms/auth.py), а тексты
// ошибок — _friendly_errors оттуда же.

const schema = z
  .object({
    surname: z.string().min(1, '«Фамилия»: обязательное поле').max(64, '«Фамилия»: максимум 64 симв.'),
    name: z.string().min(1, '«Имя»: обязательное поле').max(64, '«Имя»: максимум 64 симв.'),
    patronymic: z.string().max(64, '«Отчество»: максимум 64 симв.').nullish(),
    username: z
      .string()
      .min(3, '«Логин»: минимум 3 симв.')
      .max(64, '«Логин»: максимум 64 симв.'),
    email: z.string().email('Некорректный адрес корпоративной почты'),
    position: z.string().max(128, '«Должность»: максимум 128 симв.').optional(),
    sex: z.string().max(16).nullish(),
    password: z
      .string()
      .min(6, '«Пароль»: минимум 6 симв.')
      .max(128, '«Пароль»: максимум 128 симв.'),
    password_again: z.string().min(6, '«Повтор пароля»: минимум 6 симв.'),
  })
  .refine((d) => d.password === d.password_again, { message: 'Пароли не совпадают' });

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest('Проверьте правильность заполнения полей');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Как в бэкенде: показываем все проблемы одной строкой, без дублей.
    const messages = [...new Set(parsed.error.issues.map((i) => i.message))];
    return badRequest(messages.join('; ') || 'Проверьте правильность заполнения полей');
  }
  const form = parsed.data;

  const exists = await prisma.users.findFirst({
    where: { OR: [{ username: form.username }, { email: form.email }] },
    select: { id: true },
  });
  if (exists) {
    return NextResponse.json(
      { detail: 'Пользователь с таким логином или email уже существует' },
      { status: 409 }
    );
  }

  const user = await prisma.users.create({
    data: {
      username: form.username,
      email: form.email,
      password_hash: await hashPassword(form.password),
      surname: form.surname,
      name: form.name,
      patronymic: form.patronymic || null,
      position: form.position || 'HR-специалист',
      sex: form.sex || null,
      is_active: true,
      is_admin: false,
      is_kb_editor: false,
      can_access_pii: true,
    },
  });

  return withSession(
    NextResponse.json({ success: true, user: userJson(user as CurrentUser) }),
    user.id
  );
}
