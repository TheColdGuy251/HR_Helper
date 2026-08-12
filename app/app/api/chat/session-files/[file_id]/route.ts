import { unlink } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { parsePathId, resolveInsideDocs } from '@/lib/kb';

// Удаление вложения сессии. Порт DELETE /api/chat/session-files/{file_id}.

type Ctx = { params: Promise<{ file_id: string }> };

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const parsed = parsePathId((await params).file_id, 'file_id');
  if ('response' in parsed) return parsed.response;

  const doc =
    parsed.value === null
      ? null
      : await prisma.session_documents.findUnique({
          where: { id: parsed.value },
          select: { id: true, session_id: true, stored_path: true },
        });
  if (!doc) return notFound('Файл не найден');

  const session = await prisma.chat_sessions.findUnique({
    where: { id: doc.session_id },
    select: { id: true, dialogues: { select: { user_id: true } } },
  });
  // Тот же текст 404, что и при отсутствии файла: чужую сессию не подсвечиваем.
  if (!session || session.dialogues.user_id !== user.id) return notFound('Файл не найден');

  if (doc.stored_path) {
    // Удаляем только то, что лежит внутри docs_dir (Python: resolve + relative_to).
    const target = resolveInsideDocs(doc.stored_path);
    if (target) await unlink(target).catch(() => undefined); // missing_ok=True
  }

  await prisma.session_documents.delete({ where: { id: doc.id } });
  return NextResponse.json({ success: true });
}
