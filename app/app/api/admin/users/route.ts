import { NextResponse } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { fullName, initials, requireAdmin, shortName } from '@/lib/auth';
import type { CurrentUser } from '@/lib/auth';

// Список пользователей для админки.
// Порт GET /api/admin/users (backend/routes/admin.py, _user_brief).

// Совпадает с _user_brief из Python — поля и порядок ключей. Копия живёт и в
// [uid]/route.ts: Next разрешает route.ts экспортировать только обработчики,
// поэтому вынести общий хелпер отсюда нельзя.
function userBrief(u: CurrentUser) {
  return {
    id: u.id,
    full_name: fullName(u),
    short_name: shortName(u),
    initials: initials(u),
    email: u.email,
    username: u.username,
    position: u.position,
    is_active: Boolean(u.is_active),
    is_admin: Boolean(u.is_admin),
    is_kb_editor: Boolean(u.is_kb_editor),
    can_access_pii: Boolean(u.can_access_pii),
    created_at: isoUtc(u.created_at),
  };
}

export async function GET() {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const users = await prisma.users.findMany({
    orderBy: [{ surname: 'asc' }, { name: 'asc' }],
  });
  return NextResponse.json({ success: true, items: users.map((u) => userBrief(u)) });
}
