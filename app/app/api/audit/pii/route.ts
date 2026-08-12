import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { forbidden, requireUser, shortName } from '@/lib/auth';

// Журнал действий с персональными данными.
// Порт GET /api/audit/pii (backend/routes/audit.py).
//
// В Python роут объявлен без префикса и висит на Depends(require_user), а
// админство проверяется вручную внутри — повторяем ту же связку (401 без
// сессии, 403 обычному пользователю), чтобы коды ответов совпали 1-в-1.

/** 422 в форме FastAPI/Pydantic для некорректного query-параметра. */
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

  // `if action:` в Python — пустая строка фильтр не включает.
  const action = sp.get('action') || null;
  // `if user_id is not None:` — фильтр по 0 тоже применяется.
  const userIdRaw = sp.get('user_id');
  let userId: number | null = null;
  if (userIdRaw !== null) {
    const parsed = intQuery(userIdRaw, 'user_id', 0); // границ у user_id в Python нет
    if ('response' in parsed) return parsed.response;
    userId = parsed.value;
  }

  const where: { action?: string; user_id?: number } = {};
  if (action) where.action = action;
  if (userId !== null) where.user_id = userId;

  const total = await prisma.pii_audit.count({ where });
  const rows = await prisma.pii_audit.findMany({
    where,
    orderBy: { id: 'desc' },
    skip: offset,
    take: limit,
  });

  // Имена пользователей одним запросом
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((v): v is number => v !== null))];
  const users = userIds.length ? await prisma.users.findMany({ where: { id: { in: userIds } } }) : [];
  const usersMap = new Map(users.map((u) => [u.id, u]));

  const items = rows.map((r) => {
    // В Python поиск идёт по `if r.user_id` — user_id=0 остаётся без имени.
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
