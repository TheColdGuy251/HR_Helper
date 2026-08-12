import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { notFound } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { parseIntParam } from '@/lib/news';
import { deleteStoredFile, piiLog, requirePiiAccess } from '@/lib/pii';

// Удаление документа: файл с диска + запись в БД.
// Порт DELETE /api/pii/documents/{document_id} из backend/routes/pii.py.

type Ctx = { params: Promise<{ document_id: string }> };

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  const parsed = parseIntParam((await params).document_id, 'document_id');
  if ('response' in parsed) return parsed.response;

  const doc = await prisma.pii_documents.findUnique({ where: { id: parsed.value } });
  if (!doc) return notFound('Документ не найден');

  await deleteStoredFile(doc.storage_filename);
  await prisma.pii_documents.delete({ where: { id: doc.id } });

  await piiLog(gate.user.id, 'delete', {
    entity: 'document',
    entityId: parsed.value,
    extra: { person_id: doc.person_id },
  });
  return NextResponse.json({ success: true });
}
