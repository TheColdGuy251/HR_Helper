import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { forbidden, notFound, requireUser } from '@/lib/auth';
import { jsonBody, parsePathId, pyBool } from '@/lib/kb';

// Доступы (А6): назначение роли «редактор БЗ».
// Порт PATCH /api/kb/users/{user_id}/roles из backend/routes/kb.py.
//
// Гейт — require_user + ручная проверка is_admin, как в Python (у require_admin
// другой текст 403).

type Ctx = { params: Promise<{ user_id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  if (!gate.user.is_admin) return forbidden('Доступно только администратору');

  const parsed = parsePathId((await params).user_id, 'user_id');
  if ('response' in parsed) return parsed.response;

  const parsedBody = await jsonBody(request);
  if ('response' in parsedBody) return parsedBody.response;
  const body = parsedBody.body;

  const target =
    parsed.value === null
      ? null
      : await prisma.users.findUnique({
          where: { id: parsed.value },
          select: { id: true, is_kb_editor: true },
        });
  if (!target) return notFound('Пользователь не найден');

  let isKbEditor = target.is_kb_editor;
  if (Object.prototype.hasOwnProperty.call(body, 'is_kb_editor')) {
    isKbEditor = pyBool(body.is_kb_editor);
    await prisma.users.update({ where: { id: target.id }, data: { is_kb_editor: isKbEditor } });
  }

  return NextResponse.json({ success: true, is_kb_editor: isKbEditor });
}
