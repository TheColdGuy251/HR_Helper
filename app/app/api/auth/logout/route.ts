import { NextResponse } from 'next/server';
import { withoutSession } from '@/lib/auth';

// Выход. Порт POST /api/auth/logout из backend/routes/auth.py.

export async function POST() {
  return withoutSession(NextResponse.json({ success: true }));
}
