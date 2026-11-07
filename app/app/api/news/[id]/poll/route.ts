import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { parseIdParam, pollState } from '@/lib/news';

// Состояние голосования новости.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parseIdParam((await params).id, 'post_id');
  if ('response' in parsed) return parsed.response;

  // У поста не больше одного опроса (polls.post_id уникален).
  const poll = await prisma.polls.findUnique({ where: { post_id: parsed.value } });
  if (!poll) return NextResponse.json({ success: true, poll: null });

  return NextResponse.json({ success: true, poll: await pollState(poll, gate.user.id) });
}
