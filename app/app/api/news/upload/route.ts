import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, requireKbEditor } from '@/lib/auth';
import { NEWS_DIR, baseName, stemOf, suffixOf, toDocsPath, validationError } from '@/lib/news';

// Загрузка картинки или документа для новости.
// Порт POST /api/news/upload из backend/routes/news.py (upload_media).

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const FILE_EXT = new Set([
  '.pdf', '.docx', '.doc', '.txt', '.md', '.rst', '.csv',
  '.xlsx', '.xlsm', '.xls', '.pptx', '.ppt', '.rtf', '.odt', '.ods', '.zip',
]);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Свободное имя в каталоге: «file.png», «file (1).png», … (аналог _unique_path). */
async function uniquePath(dir: string, filename: string): Promise<string> {
  const base = stemOf(filename);
  const ext = suffixOf(filename);
  let candidate = path.join(dir, filename);
  let i = 1;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

export async function POST(request: NextRequest) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return validationError(['body', 'file'], 'missing', 'Field required', null);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return validationError(['body', 'file'], 'missing', 'Field required', null);
  }

  const name = baseName(file.name || '');
  const ext = suffixOf(name).toLowerCase();
  const isImage = IMAGE_EXT.has(ext);
  if (!isImage && !FILE_EXT.has(ext)) {
    return badRequest(`Неподдерживаемый формат: ${ext || '—'}`);
  }

  await mkdir(NEWS_DIR, { recursive: true });
  const target = await uniquePath(NEWS_DIR, name || 'file');
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(target, bytes);

  const media = await prisma.news_media.create({
    data: {
      original_name: name || path.basename(target),
      stored_path: toDocsPath(target),
      mime_type: file.type || null,
      size: bytes.length,
      is_image: isImage,
      uploaded_by: gate.user.id,
    },
  });

  return NextResponse.json({
    success: true,
    media: {
      id: media.id,
      name: media.original_name,
      size: media.size,
      is_image: media.is_image,
      url: `/api/news/media/${media.id}`,
    },
  });
}
