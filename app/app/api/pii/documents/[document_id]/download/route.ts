import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { notFound } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { parseIntParam } from '@/lib/news';
import { contentDisposition, loadDecrypted, piiLog, requirePiiAccess } from '@/lib/pii';

// Скачивание документа: расшифровка на лету + запись в аудит.
// Порт GET /api/pii/documents/{document_id}/download из backend/routes/pii.py.

type Ctx = { params: Promise<{ document_id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  const parsed = parseIntParam((await params).document_id, 'document_id');
  if ('response' in parsed) return parsed.response;

  const doc = await prisma.pii_documents.findUnique({ where: { id: parsed.value } });
  if (!doc) return notFound('Документ не найден');

  const data = await loadDecrypted(doc.storage_filename);
  if (!data) return notFound('Файл отсутствует на диске');

  await piiLog(gate.user.id, 'download', { entity: 'document', entityId: doc.id });

  // Starlette дописывает кодировку к text/* — без этого .txt/.md браузер
  // покажет в latin-1.
  let mediaType = doc.mime_type || 'application/octet-stream';
  if (mediaType.startsWith('text/') && !mediaType.toLowerCase().includes('charset=')) {
    mediaType += '; charset=utf-8';
  }

  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': mediaType,
      // RFC 5987: кириллические имена нельзя класть в заголовок как есть (latin-1).
      'Content-Disposition': contentDisposition(doc.original_filename),
      'Content-Length': String(data.length),
    },
  });
}
