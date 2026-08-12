import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { forbidden, requireUser, unauthorized, verifyPassword } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  PII_TOKEN_TTL_SEC,
  issueToken,
  modelBody,
  piiLog,
  pydanticErrors,
  serializePiiCookie,
} from '@/lib/pii';

// Повторная аутентификация по паролю перед доступом к ПДн.
// Порт POST /api/pii/reauth из backend/routes/pii.py (pii_reauth).

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  if (!user.can_access_pii) {
    await piiLog(user.id, 'reauth_fail', { extra: { reason: 'no_access' } });
    return forbidden('Доступ к персональным данным запрещён');
  }

  // ReauthRequest(password: str) — пустое тело и неверный тип дают 422, как в pydantic.
  const parsed = await modelBody(request);
  if ('response' in parsed) return parsed.response;
  const password = parsed.body.password;
  if (password === undefined) {
    return pydanticErrors([
      { type: 'missing', loc: ['body', 'password'], msg: 'Field required', input: parsed.body },
    ]);
  }
  // null — это не «поле отсутствует», а неверный тип: pydantic даёт string_type.
  if (typeof password !== 'string') {
    return pydanticErrors([
      {
        type: 'string_type',
        loc: ['body', 'password'],
        msg: 'Input should be a valid string',
        input: password,
      },
    ]);
  }

  // password_hash не входит в CurrentUser — берём отдельным запросом.
  const row = await prisma.users.findUnique({
    where: { id: user.id },
    select: { password_hash: true },
  });
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    await piiLog(user.id, 'reauth_fail', { extra: { reason: 'bad_password' } });
    return unauthorized('Неверный пароль');
  }

  await piiLog(user.id, 'reauth_ok');

  const response = NextResponse.json({ success: true, expires_in: PII_TOKEN_TTL_SEC });
  response.headers.append('Set-Cookie', serializePiiCookie(issueToken(user.id)));
  return response;
}
