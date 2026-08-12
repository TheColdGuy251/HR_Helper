import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { notFound, requireAdmin } from '@/lib/auth';

// Диалоги пользователя с ботом + число сообщений в каждом.
// Порт GET /api/admin/users/{uid}/dialogues (backend/routes/admin.py).

function parseIntParam(raw: string): number | null {
  return /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : null;
}

function invalidIntPath(name: string, input: string) {
  return NextResponse.json(
    {
      detail: [
        {
          type: 'int_parsing',
          loc: ['path', name],
          msg: 'Input should be a valid integer, unable to parse string as an integer',
          input,
        },
      ],
    },
    { status: 422 }
  );
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ uid: string }> }) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { uid } = await params;
  const userId = parseIntParam(uid);
  if (userId === null) return invalidIntPath('uid', uid);

  const owner = await prisma.users.findUnique({ where: { id: userId }, select: { id: true } });
  if (!owner) return notFound('Пользователь не найден');

  const dialogues = await prisma.dialogues.findMany({
    where: { user_id: userId },
    orderBy: { last_activity: 'desc' },
  });

  // Считаем сообщения одним groupBy вместо запроса на каждый диалог: счёт тот
  // же (все роли и все варианты ответа), но без N+1.
  const sessions = dialogues.length
    ? await prisma.chat_sessions.findMany({
        where: { dialogue_id: { in: dialogues.map((d) => d.id) } },
        select: { id: true, dialogue_id: true },
      })
    : [];
  const sessionIds = sessions.map((s) => s.id);
  const grouped = sessionIds.length
    ? await prisma.chat_messages.groupBy({
        by: ['session_id'],
        where: { session_id: { in: sessionIds } },
        _count: { _all: true },
      })
    : [];
  const perSession = new Map(grouped.map((g) => [g.session_id, g._count._all]));
  const perDialogue = new Map<number, number>();
  for (const s of sessions) {
    perDialogue.set(s.dialogue_id, (perDialogue.get(s.dialogue_id) ?? 0) + (perSession.get(s.id) ?? 0));
  }

  const items = dialogues.map((d) => ({
    id: d.id,
    title: d.title || 'Без названия',
    is_finished: Boolean(d.is_finished),
    last_activity: isoUtc(d.last_activity),
    messages: perDialogue.get(d.id) ?? 0,
  }));

  return NextResponse.json({ success: true, items });
}
