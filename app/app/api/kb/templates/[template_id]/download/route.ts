import path from 'node:path';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { forbidden, notFound, requireUser } from '@/lib/auth';
import {
  baseName,
  boolQuery,
  fileResponse,
  isFile,
  parsePathId,
  resolveInsideDocs,
  suffixOf,
  templateDisplayPath,
  TEMPLATES_DIR,
} from '@/lib/kb';
import { previewPdfResponse } from '@/lib/file-preview';

// Отдача файла шаблона.
// Порт GET /api/kb/templates/{template_id}/download из backend/routes/kb.py.

type Ctx = { params: Promise<{ template_id: string }> };

const TEMPLATE_MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
};

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).template_id, 'template_id');
  if ('response' in parsed) return parsed.response;

  const query = request.nextUrl.searchParams;
  const inline = boolQuery(query.get('inline'), 'inline');
  if ('response' in inline) return inline.response;
  const asFormat = query.get('as');

  const tpl =
    parsed.value === null
      ? null
      : await prisma.doc_templates.findUnique({
          where: { id: parsed.value },
          select: { id: true, file_path: true },
        });
  if (!tpl) return notFound('Шаблон не найден');

  // Относительный путь Python достраивает от docs/templates.
  const src = path.isAbsolute(tpl.file_path)
    ? tpl.file_path
    : path.join(TEMPLATES_DIR, tpl.file_path);
  // Отсутствие исходника Python ловит как FileNotFoundError (подвид OSError) —
  // то есть отвечает 403, а не 404. Повторяем.
  if (!(await isFile(src))) return forbidden('Доступ к файлу запрещён');

  const file = resolveInsideDocs(await templateDisplayPath(tpl.id, src));
  if (!file) return forbidden('Доступ к файлу запрещён');
  if (!(await isFile(file))) return notFound('Файл шаблона отсутствует');

  // Шаблоны бывают только .docx/.pdf — превью для них не собирается (как и в
  // Python) и уйдёт оригинал. Ветка оставлена ради единообразия с документами.
  const suffix = suffixOf(baseName(file)).toLowerCase();
  if (asFormat === 'pdf') {
    const preview = await previewPdfResponse(file);
    if (preview) return preview;
  }

  // Имя для скачивания — по оригиналу (у превью-файла имя = id).
  const resp = await fileResponse(file, {
    filename: baseName(tpl.file_path),
    mediaType: TEMPLATE_MIME[suffix] || 'application/octet-stream',
    inline: inline.value,
  });
  return resp ?? notFound('Файл шаблона отсутствует');
}
