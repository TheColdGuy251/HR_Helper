import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { parseIntParam, pollState } from '@/lib/news';

// Состояние голосования новости.
// Порт GET /api/news/{post_id}/poll из backend/routes/news.py (get_poll).

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parseIntParam((await params).id, 'post_id');
  if ('response' in parsed) return parsed.response;

  const poll = await prisma.news_polls.findFirst({
    where: { post_id: parsed.value },
    orderBy: { id: 'asc' },
  });
  if (!poll) return NextResponse.json({ success: true, poll: null });

  return NextResponse.json({ success: true, poll: await pollState(poll, gate.user.id) });
}
