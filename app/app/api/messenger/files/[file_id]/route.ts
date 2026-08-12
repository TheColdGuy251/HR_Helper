import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { baseName, boolQuery, fileResponse, isFile, parsePathId, suffixOf } from '@/lib/kb';
import { previewPdfResponse } from '@/lib/file-preview';
import { MIME, fromUploadPath, messageById } from '@/lib/messenger';

// Отдача вложения мессенджера.
// Порт GET /api/messenger/files/{file_id} из backend/routes/messenger.py.

type Ctx = { params: Promise<{ file_id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const parsed = parsePathId((await params).file_id, 'file_id');
  if ('response' in parsed) return parsed.response;
  const download = boolQuery(request.nextUrl.searchParams.get('download'), 'download');
  if ('response' in download) return download.response;
  const asFormat = request.nextUrl.searchParams.get('as');

  const rec =
    parsed.value === null
      ? null
      : await prisma.user_message_files.findUnique({ where: { id: parsed.value } });
  const file = rec ? fromUploadPath(rec.stored_path) : null;
  if (!rec || !file || !(await isFile(file))) return notFound('Файл не найден');

  // Доступ: владелец файла или участник диалога сообщения. Именно 404, чтобы не
  // раскрывать существование чужих файлов перебором id.
  if (rec.owner_id !== me) {
    const msg = rec.message_id ? await messageById(rec.message_id) : null;
    if (!msg || (!msg.is_general && me !== msg.sender_id && me !== msg.recipient_id)) {
      return notFound('Файл не найден');
    }
  }

  // Презентации показываем как PDF (LibreOffice + кэш); для прочих форматов
  // превью нет и ниже уходит исходный файл.
  if (asFormat === 'pdf') {
    const preview = await previewPdfResponse(file);
    if (preview) return preview;
  }

  const ext = suffixOf(baseName(file)).toLowerCase();

  const resp = await fileResponse(file, {
    filename: rec.original_name,
    mediaType: MIME[ext] || 'application/octet-stream',
    inline: !download.value,
  });
  return resp ?? notFound('Файл не найден');
}
