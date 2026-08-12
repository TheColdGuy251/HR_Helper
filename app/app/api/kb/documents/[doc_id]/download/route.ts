import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { forbidden, notFound, requireUser } from '@/lib/auth';
import { baseName, boolQuery, fileResponse, isFile, parsePathId, resolveInsideDocs } from '@/lib/kb';
import { previewPdfResponse } from '@/lib/file-preview';

// Отдача файла документа базы знаний.
// Порт GET /api/kb/documents/{doc_id}/download из backend/routes/kb.py.

type Ctx = { params: Promise<{ doc_id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).doc_id, 'doc_id');
  if ('response' in parsed) return parsed.response;

  const query = request.nextUrl.searchParams;
  const inline = boolQuery(query.get('inline'), 'inline');
  if ('response' in inline) return inline.response;
  const asFormat = query.get('as');

  const doc =
    parsed.value === null
      ? null
      : await prisma.kb_documents.findUnique({ where: { id: parsed.value } });
  if (!doc) return notFound('Документ не найден');

  // Веб-источники открываем по оригинальному URL. Собираем ответ вручную:
  // NextResponse.redirect валидирует URL, а RedirectResponse в Python — нет.
  if (doc.source_type === 'web') {
    if (!doc.source_uri) return notFound('URL источника отсутствует');
    return new NextResponse(null, { status: 302, headers: { Location: doc.source_uri } });
  }

  // Локальные файлы — отдаём из docs/local. Защита от path-traversal:
  // разрешаем только файлы внутри docs/.
  const file = resolveInsideDocs(doc.source_uri);
  if (!file) return forbidden('Доступ к файлу запрещён');
  if (!(await isFile(file))) return notFound('Файл отсутствует на диске');

  // as=pdf — отдаём PDF-версию презентации (pptx/ppt/odp) для предпросмотра.
  // Для остальных форматов превью нет, и ниже уходит исходный файл.
  if (asFormat === 'pdf') {
    const preview = await previewPdfResponse(file);
    if (preview) return preview;
  }

  // inline=1 — показать в браузере (для PDF в iframe просмотрщика); иначе скачать
  const resp = await fileResponse(file, {
    filename: baseName(file),
    mediaType: doc.mime_type || 'application/octet-stream',
    inline: inline.value,
  });
  return resp ?? notFound('Файл отсутствует на диске');
}
