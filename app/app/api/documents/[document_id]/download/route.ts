import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { baseName, boolQuery, fileResponse, fromDocsPath, isFile, parsePathId, suffixOf } from '@/lib/kb';
import { previewPdfResponse } from '@/lib/file-preview';

// Отдача файла сгенерированного документа.
// Порт GET /api/documents/{document_id}/download из backend/routes/documents.py.

type Ctx = { params: Promise<{ document_id: string }> };

const MEDIA: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
};

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).document_id, 'document_id');
  if ('response' in parsed) return parsed.response;

  const query = request.nextUrl.searchParams;
  const inline = boolQuery(query.get('inline'), 'inline');
  if ('response' in inline) return inline.response;
  const asFormat = query.get('as');

  // Документы общие для всех сотрудников (внутренний инструмент) — без проверки владельца.
  const doc =
    parsed.value === null
      ? null
      : await prisma.my_documents.findUnique({ where: { id: parsed.value } });
  if (!doc) return notFound('Документ не найден');

  const file = doc.file_path ? fromDocsPath(doc.file_path) : null;
  if (!file || !(await isFile(file))) return notFound('Файл документа отсутствует');

  const name = baseName(file);
  const ext = suffixOf(name).toLowerCase();

  // as=pdf — PDF-версия презентации (pptx/ppt/odp) для предпросмотра; для
  // остальных форматов превью нет и ниже уходит исходный файл.
  if (asFormat === 'pdf') {
    const preview = await previewPdfResponse(file);
    if (preview) return preview;
  }

  const resp = await fileResponse(file, {
    filename: name,
    mediaType: MEDIA[ext] || 'application/octet-stream',
    inline: inline.value,
  });
  return resp ?? notFound('Файл документа отсутствует');
}
