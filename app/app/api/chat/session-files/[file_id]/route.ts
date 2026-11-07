import { unlink } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { parsePathId, resolveInsideDocs } from '@/lib/kb';

// Удаление вложения чата.

type Ctx = { params: Promise<{ file_id: string }> };

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const parsed = parsePathId((await params).file_id, 'file_id');
  if ('response' in parsed) return parsed.response;

  const doc = await prisma.chat_attachments.findUnique({
    where: { id: parsed.value },
    select: { id: true, stored_path: true, dialogue: { select: { user_id: true } } },
  });
  // Тот же текст 404, что и при отсутствии файла: чужой диалог не подсвечиваем.
  if (!doc || doc.dialogue.user_id !== user.id) return notFound('Файл не найден');

  if (doc.stored_path) {
    // Удаляем только то, что лежит внутри docs_dir.
    const target = resolveInsideDocs(doc.stored_path);
    if (target) await unlink(target).catch(() => undefined); // missing_ok=True
  }

  await prisma.chat_attachments.delete({ where: { id: doc.id } });
  return NextResponse.json({ success: true });
}
