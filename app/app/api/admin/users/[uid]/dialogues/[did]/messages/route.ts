import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { notFound, requireAdmin } from '@/lib/auth';

// Транскрипт диалога пользователя с ботом.
// Порт GET /api/admin/users/{uid}/dialogues/{did}/messages (backend/routes/admin.py).

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

/** len(m.sources or []) из Python: JSON-массив → длина, всё прочее → 0. */
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
  const userId = parseIntParam(uid);
  if (userId === null) return invalidIntPath('uid', uid);
  const dialogueId = parseIntParam(did);
  if (dialogueId === null) return invalidIntPath('did', did);

  // Диалог должен принадлежать именно этому пользователю — иначе 404.
  const dialogue = await prisma.dialogues.findUnique({ where: { id: dialogueId } });
  if (!dialogue || dialogue.user_id !== userId) return notFound('Диалог не найден');

  const sessions = await prisma.chat_sessions.findMany({
    where: { dialogue_id: dialogueId },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);

  // Только активные варианты ответа и реплики user/assistant (без system).
  const msgs = sessionIds.length
    ? await prisma.chat_messages.findMany({
        where: {
          session_id: { in: sessionIds },
          variant_active: true,
          role: { in: ['user', 'assistant'] },
        },
        orderBy: { id: 'asc' },
      })
    : [];

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
