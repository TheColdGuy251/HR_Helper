import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { $Enums, type Prisma } from '@prisma/client';
import { isoUtc, prisma } from '@/lib/db';
import { forbidden, requireUser, shortName } from '@/lib/auth';
import { asUuid } from '@/lib/ids';

// Журнал действий с персональными данными.
//
// Гейт - сессия + ручная проверка is_admin: 401 без сессии, 403 обычному
// пользователю.

/** 422 для некорректного query-параметра. */
function queryError(type: string, name: string, msg: string, input: unknown, ctx?: object) {
  const item: Record<string, unknown> = { type, loc: ['query', name], msg, input };
  if (ctx) item.ctx = ctx;
  return NextResponse.json({ detail: [item] }, { status: 422 });
}

/**
 * Разбор целочисленного query-параметра с границами Query(ge=..., le=...).
 * Возвращает либо значение, либо готовый ответ 422.
 */
function intQuery(
  raw: string | null,
  name: string,
  fallback: number,
  ge?: number,
  le?: number
): { value: number } | { response: NextResponse } {
  if (raw === null) return { value: fallback };
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    return {
      response: queryError(
        'int_parsing',
        name,
        'Input should be a valid integer, unable to parse string as an integer',
        raw
      ),
    };
  }
  const value = Number(raw);
  if (ge !== undefined && value < ge) {
    return {
      response: queryError(
        'greater_than_equal',
        name,
        `Input should be greater than or equal to ${ge}`,
        raw,
        { ge }
      ),
    };
  }
  if (le !== undefined && value > le) {
    return {
      response: queryError('less_than_equal', name, `Input should be less than or equal to ${le}`, raw, {
        le,
      }),
    };
  }
  return { value };
}

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;
  if (!user.is_admin) return forbidden('Доступ только для администраторов');

  const sp = request.nextUrl.searchParams;

  const limitArg = intQuery(sp.get('limit'), 'limit', 100, 1, 500);
  if ('response' in limitArg) return limitArg.response;
  const offsetArg = intQuery(sp.get('offset'), 'offset', 0, 0);
  if ('response' in offsetArg) return offsetArg.response;
  const limit = limitArg.value;
  const offset = offsetArg.value;

  // Пустая строка фильтр не включает.
  const action = sp.get('action') || null;
  const userIdRaw = sp.get('user_id');
  let userId: string | null = null;
  if (userIdRaw !== null) {
    userId = asUuid(userIdRaw);
    if (userId === null) {
      return queryError('uuid_parsing', 'user_id', 'Input should be a valid UUID', userIdRaw);
    }
  }

  // action - enum: неизвестное действие просто ничего не находит (как раньше
  // строковое сравнение), а не роняет запрос ошибкой Prisma.
  if (action && !(action in $Enums.pii_action)) {
    return NextResponse.json({ success: true, items: [], total: 0, limit, offset });
  }
  const where: Prisma.pii_auditWhereInput = {};
  if (action) where.action = action as $Enums.pii_action;
  if (userId !== null) where.user_id = userId;

  const total = await prisma.pii_audit.count({ where });
  const rows = await prisma.pii_audit.findMany({
    where,
    orderBy: { id: 'desc' },
    skip: offset,
    take: limit,
  });

  // Имена пользователей одним запросом
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((v): v is string => v !== null))];
  const users = userIds.length ? await prisma.users.findMany({ where: { id: { in: userIds } } }) : [];
  const usersMap = new Map(users.map((u) => [u.id, u]));

  const items = rows.map((r) => {
    const u = r.user_id ? usersMap.get(r.user_id) : undefined;
    return {
      id: r.id,
      at: isoUtc(r.at),
      user_id: r.user_id,
      user_name: u ? shortName(u) : null,
      user_email: u ? u.email : null,
      action: r.action,
      entity: r.entity,
      entity_id: r.entity_id,
      extra: r.extra,
    };
  });

  return NextResponse.json({ success: true, items, total, limit, offset });
}
