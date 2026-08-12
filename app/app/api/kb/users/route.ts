import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { forbidden, fullName, requireUser } from '@/lib/auth';

// Доступы (А6): список активных пользователей с ролями.
// Порт GET /api/kb/users из backend/routes/kb.py (list_users_roles).
//
// Гейт именно require_user + ручная проверка is_admin — как в Python. Это важно:
// require_admin отдал бы другой текст 403 («Доступ только для администраторов»).

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  if (!gate.user.is_admin) return forbidden('Доступно только администратору');

  const rows = await prisma.users.findMany({
    where: { is_active: true },
    orderBy: [{ surname: 'asc' }, { name: 'asc' }],
  });

  return NextResponse.json({
    success: true,
    items: rows.map((u) => ({
      id: u.id,
      full_name: fullName(u),
      username: u.username,
      position: u.position,
      is_admin: u.is_admin,
      is_kb_editor: u.is_kb_editor,
    })),
  });
}
