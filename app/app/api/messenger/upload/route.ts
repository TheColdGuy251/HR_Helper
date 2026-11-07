import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, requireUser } from '@/lib/auth';
import { baseName, suffixOf } from '@/lib/kb';
import { validationError } from '@/lib/news';
import {
  ALLOWED_EXT,
  IMAGE_EXT,
  MAX_UPLOAD_BYTES,
  UPLOAD_DIR,
  imageSize,
  serializeFile,
} from '@/lib/messenger';

// Загрузка вложения (по одному файлу за запрос).
//
// Файлы лежат в backend/docs/messenger, имя - случайный hex + исходное
// расширение (оригинальное имя хранится в БД).

export async function POST(request: NextRequest) {
  const gate = await requireUser();
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

  const ext = suffixOf(baseName(file.name || '')).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return badRequest(`Неподдерживаемый формат: ${ext || '—'}`);

  // Тело уже разобрано в память, поэтому лимит размера проверяем до записи на
  // диск.
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > MAX_UPLOAD_BYTES) return badRequest('Файл больше 20 МБ');

  await mkdir(UPLOAD_DIR, { recursive: true });
  const stored = path.join(UPLOAD_DIR, `${randomUUID().replace(/-/g, '')}${ext}`);
  await writeFile(stored, bytes);

  const isImage = IMAGE_EXT.has(ext);
  const size = isImage ? imageSize(bytes) : null;

  const rec = await prisma.user_message_files.create({
    data: {
      owner_id: gate.user.id,
      original_name: file.name || path.basename(stored),
      stored_path: stored,
      content_type: file.type || null,
      size_bytes: bytes.length,
      is_image: isImage,
      img_w: size?.w ?? null,
      img_h: size?.h ?? null,
    },
  });

  return NextResponse.json(serializeFile(rec));
}
