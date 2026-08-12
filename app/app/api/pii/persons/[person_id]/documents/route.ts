import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, notFound } from '@/lib/auth';
import { isoUtc, prisma } from '@/lib/db';
import { parseIntParam, validationError } from '@/lib/news';
import { piiLog, requirePiiAccess, storeEncrypted } from '@/lib/pii';

// Прямая загрузка документа в существующую карточку. Без распознавания.
// Порт POST /api/pii/persons/{person_id}/documents из backend/routes/pii.py (upload_direct).

type Ctx = { params: Promise<{ person_id: string }> };

const ALLOWED_EXT = new Set(['.pdf', '.docx', '.doc', '.txt', '.md', '.jpg', '.jpeg', '.png']);
const MAX_BYTES = 30 * 1024 * 1024; // 30 МБ

export async function POST(request: NextRequest, { params }: Ctx) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  const parsed = parseIntParam((await params).person_id, 'person_id');
  if ('response' in parsed) return parsed.response;

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
  const noteRaw = form.get('note');
  const note = typeof noteRaw === 'string' ? noteRaw : null;

  const person = await prisma.pii_persons.findUnique({ where: { id: parsed.value } });
  if (!person) return notFound('Сотрудник не найден');

  // Расширение берётся от последней точки в ИМЕНИ КАК ПРИШЛО — как rsplit в Python.
  const filename = file.name || '';
  const suffix = filename.includes('.')
    ? `.${filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()}`
    : '';
  if (!ALLOWED_EXT.has(suffix)) return badRequest(`Неподдерживаемый формат: ${suffix || '?'}`);

  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > MAX_BYTES) return badRequest('Файл больше 30 МБ');

  const stored = await storeEncrypted(data);

  const doc = await prisma.pii_documents.create({
    data: {
      person_id: person.id,
      original_filename: filename || stored.storageName,
      storage_filename: stored.storageName,
      mime_type: file.type || null,
      size_bytes: stored.size,
      note: note || null,
      uploaded_by: gate.user.id,
    },
  });
  await piiLog(gate.user.id, 'upload', {
    entity: 'document',
    entityId: doc.id,
    extra: { person_id: person.id },
  });

  return NextResponse.json({
    success: true,
    document: {
      id: doc.id,
      filename: doc.original_filename,
      size_bytes: doc.size_bytes,
      uploaded_at: isoUtc(doc.uploaded_at),
    },
  });
}
