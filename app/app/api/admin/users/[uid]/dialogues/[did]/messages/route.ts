import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { notFound, requireAdmin } from '@/lib/auth';
import { parsePathId } from '@/lib/kb';

// Транскрипт диалога пользователя с ботом.

/** Число источников: JSON-массив -> длина, всё прочее -> 0. */
function sourcesCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ uid: string; did: string }> }
) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { uid, did } = await params;
  const user = parsePathId(uid, 'uid');
  if ('response' in user) return user.response;
  const dlg = parsePathId(did, 'did');
  if ('response' in dlg) return dlg.response;

  // Диалог должен принадлежать именно этому пользователю - иначе 404.
  const dialogue = await prisma.dialogues.findUnique({ where: { id: dlg.value } });
  if (!dialogue || dialogue.user_id !== user.value) return notFound('Диалог не найден');

  // Только активные варианты ответа.
  const msgs = await prisma.chat_messages.findMany({
    where: { dialogue_id: dialogue.id, variant_active: true },
    orderBy: { id: 'asc' },
  });

  const items = msgs.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content || '',
    sources: sourcesCount(m.sources),
    created_at: isoUtc(m.finished_at ?? m.created_at),
  }));

  return NextResponse.json({
    success: true,
    title: dialogue.title || 'Без названия',
    items,
  });
}
