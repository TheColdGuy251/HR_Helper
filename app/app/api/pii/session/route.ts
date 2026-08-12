import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { readPiiToken, tokenRemainingSeconds } from '@/lib/pii';

// Состояние PII-доступа: показывать ли UI модалку с паролем.
// Порт GET /api/pii/session из backend/routes/pii.py (pii_session_state).

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const canAccess = Boolean(gate.user.can_access_pii);
  // remaining_seconds — реальный остаток до истечения токена (0 если просрочен/нет).
  const remaining = canAccess ? tokenRemainingSeconds(await readPiiToken(), gate.user.id) : 0;

  return NextResponse.json({
    can_access: canAccess,
    active: remaining > 0,
    remaining_seconds: remaining,
  });
}
