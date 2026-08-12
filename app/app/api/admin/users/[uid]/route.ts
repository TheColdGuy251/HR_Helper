import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { badRequest, fullName, initials, notFound, requireAdmin, shortName } from '@/lib/auth';
import type { CurrentUser } from '@/lib/auth';

// Изменение ролей и удаление пользователя.
// Порт PATCH/DELETE /api/admin/users/{uid} (backend/routes/admin.py).

// Копия _user_brief из ../route.ts: Next разрешает route.ts экспортировать
// только обработчики, поэтому общий хелпер отсюда не вынести.
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

const ROLE_FIELDS = ['is_admin', 'is_kb_editor', 'can_access_pii', 'is_active'] as const;
type RoleField = (typeof ROLE_FIELDS)[number];

/** Python int(): знак и пробелы по краям допустимы. */
function parseIntParam(raw: string): number | null {
  return /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : null;
}

/** FastAPI отвечает 422 на нечисловой path-параметр — повторяем форму тела. */
function invalidIntPath(name: string, input: string) {
  return NextResponse.json(
    {
      detail: [
        {
          type: 'int_parsing',
          loc: ['path', name],
          msg: 'Input should be a valid integer, unable to parse string as an integer',
          input,
        },
      ],
    },
    { status: 422 }
  );
}

/** 422 на некорректное тело — как Body(...) в FastAPI. */
function invalidBody(type: string, loc: unknown[], msg: string, input: unknown) {
  return NextResponse.json({ detail: [{ type, loc, msg, input }] }, { status: 422 });
}

/** Python bool(): пустые строка/список/словарь тоже дают False. */
function pyBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ uid: string }> }) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;
  const admin = gate.user;

  const { uid } = await params;
  const id = parseIntParam(uid);
  if (id === null) return invalidIntPath('uid', uid);

  const raw = await request.text();
  if (!raw) return invalidBody('missing', ['body'], 'Field required', null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidBody('json_invalid', ['body', 0], 'JSON decode error', {});
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidBody('dict_type', ['body'], 'Input should be a valid dictionary', parsed);
  }
  const payload = parsed as Record<string, unknown>;

  const target = await prisma.users.findUnique({ where: { id } });
  if (!target) return notFound('Пользователь не найден');

  // Защита от «отстрела себе ноги»: нельзя снять с себя админку или
  // деактивировать себя. В Python сравнение строгое (`is False`), поэтому
  // проверяем именно литерал false, а не любое ложное значение.
  if (target.id === admin.id && (payload.is_admin === false || payload.is_active === false)) {
    return badRequest('Нельзя снять права администратора или деактивировать себя');
  }

  const changed: Partial<Record<RoleField, boolean>> = {};
  for (const field of ROLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const value = pyBool(payload[field]);
    if (target[field] !== value) changed[field] = value;
  }

  const item = Object.keys(changed).length
    ? await prisma.users.update({ where: { id }, data: changed })
    : target;

  return NextResponse.json({ success: true, item: userBrief(item) });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;
  const admin = gate.user;

  const { uid } = await params;
  const id = parseIntParam(uid);
  if (id === null) return invalidIntPath('uid', uid);

  // Порядок проверок как в Python: сначала «сам себя», потом существование.
  if (id === admin.id) return badRequest('Нельзя удалить собственную учётную запись');

  const target = await prisma.users.findUnique({ where: { id }, select: { id: true } });
  if (!target) return notFound('Пользователь не найден');

  // FK-каскады в PostgreSQL удалят диалоги, сессии, сообщения бота и
  // мессенджера. Аудит и загруженные PII-файлы отвязываются (SET NULL).
  await prisma.users.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
