import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { queueStatus } from '@/lib/ml/llm';

// Снимок очереди ассистента.

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const s = await queueStatus();
  return NextResponse.json({
    success: true,
    // Число выполняющихся генераций в ответе называется `active` (в lib/ml/llm.ts
    // - `running`). Поле `available` в ответ не кладём.
    active: s.running,
    waiting: s.waiting,
    max_concurrent: s.max_concurrent,
    max_waiting: s.max_waiting,
    max_per_user: s.max_per_user,
  });
}
