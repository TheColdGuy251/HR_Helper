import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { queueStatus } from '@/lib/ml/llm';

// Снимок очереди ассистента. Порт GET /api/chat/queue-status
// (backend/routes/chat.py + services/assistant_queue.py: stats()).

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const s = await queueStatus();
  return NextResponse.json({
    success: true,
    // Python называет число выполняющихся генераций `active`, lib/ml/llm.ts —
    // `running`: приводим к имени Python. Поле `available` (загрузилась ли
    // модель) в ответ не кладём — у FastAPI его нет.
    active: s.running,
    waiting: s.waiting,
    max_concurrent: s.max_concurrent,
    max_waiting: s.max_waiting,
    max_per_user: s.max_per_user,
  });
}
