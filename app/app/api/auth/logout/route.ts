import { NextResponse } from 'next/server';
import { withoutSession } from '@/lib/auth';

// Выход.

export async function POST() {
  return withoutSession(NextResponse.json({ success: true }));
}
