import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { forbidden, notFound, requireUser } from '@/lib/auth';
import { baseName, parseIntParam, resolveInsideDocs, validationError } from '@/lib/news';
import { previewPdfResponse } from '@/lib/file-preview';

// Отдача файла новости.
// Порт GET /api/news/media/{media_id} из backend/routes/news.py (get_media).

type Ctx = { params: Promise<{ id: string }> };

// Значения bool так разбирает pydantic; всё остальное — ошибка валидации.
const TRUE_VALUES = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_VALUES = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

/** urllib.parse.quote(s) с safe='/' — нужен для Content-Disposition, как в Starlette. */
function pyQuote(s: string): string {
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~/-]/.test(ch)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const quoted = pyQuote(filename);
  return quoted === filename
    ? `${type}; filename="${filename}"`
    : `${type}; filename*=utf-8''${quoted}`;
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parseIntParam((await params).id, 'media_id');
  if ('response' in parsed) return parsed.response;

  const query = request.nextUrl.searchParams;
  const rawDownload = query.get('download');
  let download = false;
  if (rawDownload !== null) {
    const v = rawDownload.trim().toLowerCase();
    if (TRUE_VALUES.has(v)) download = true;
    else if (!FALSE_VALUES.has(v)) {
      return validationError(
        ['query', 'download'],
        'bool_parsing',
        'Input should be a valid boolean, unable to interpret input',
        rawDownload
      );
    }
  }
  const asFormat = query.get('as');

  const media = await prisma.news_media.findUnique({ where: { id: parsed.value } });
  if (!media) return notFound('Файл не найден');

  const file = resolveInsideDocs(media.stored_path);
  if (!file) return forbidden('Доступ к файлу запрещён');

  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) return notFound('Файл отсутствует на диске');

  // Презентации (pptx/ppt/odp) браузер не покажет — отдаём PDF-версию из кэша
  // LibreOffice. Для остальных форматов превью нет и уходит исходный файл.
  if (asFormat === 'pdf') {
    const preview = await previewPdfResponse(file);
    if (preview) return preview;
  }

  // Картинки и pdf показываем прямо в браузере; прочее — по ?download=1 качаем.
  const filename = media.original_name || baseName(file);
  const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;

  return new NextResponse(stream, {
    headers: {
      'Content-Type': media.mime_type || 'application/octet-stream',
      'Content-Length': String(info.size),
      'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', filename),
    },
  });
}
