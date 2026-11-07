import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { serializePiiCookie } from '@/lib/pii';

// Досрочный выход из режима ПДн (кнопка "Заблокировать").

export async function POST() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const response = NextResponse.json({ success: true });
  // Удаление cookie - та же cookie с нулевым сроком жизни.
  response.headers.append('Set-Cookie', serializePiiCookie('', 0));
  return response;
}
