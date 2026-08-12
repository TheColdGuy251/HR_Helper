import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { serializePiiCookie } from '@/lib/pii';

// Досрочный выход из режима ПДн (кнопка «Заблокировать»).
// Порт POST /api/pii/reauth/logout из backend/routes/pii.py (pii_reauth_logout).

export async function POST() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const response = NextResponse.json({ success: true });
  // delete_cookie в Starlette — та же cookie с нулевым сроком жизни.
  response.headers.append('Set-Cookie', serializePiiCookie('', 0));
  return response;
}
