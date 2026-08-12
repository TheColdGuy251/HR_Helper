import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, notFound } from '@/lib/auth';
import { isoUtc, prisma } from '@/lib/db';
import {
  BAD_DATE,
  normalizeFio,
  parseBirthDate,
  piiLog,
  pydanticErrors,
  requirePiiAccess,
  storeEncrypted,
  type PydanticError,
} from '@/lib/pii';

// Окончательная загрузка после quick-analyze: документ либо привязывается к
// существующей карточке (person_id), либо к новой, созданной по ФИО из формы.
// Порт POST /api/pii/upload/commit из backend/routes/pii.py (upload_commit).

const ALLOWED_EXT = new Set(['.pdf', '.docx', '.doc', '.txt', '.md', '.jpg', '.jpeg', '.png']);
const MAX_BYTES = 30 * 1024 * 1024; // 30 МБ

/** `str | None = Form(default=None)`: отсутствующее поле — None. */
function formStr(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' ? value : null;
}

export async function POST(request: NextRequest) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return pydanticErrors([
      { type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null },
    ]);
  }

  // FastAPI проверяет все поля формы разом, до тела обработчика, и отдаёт
  // список ошибок в порядке объявления параметров: сначала file, затем person_id.
  const errors: PydanticError[] = [];
  const file = form.get('file');
  if (!(file instanceof File)) {
    errors.push({ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null });
  }
  let personId: number | null = null;
  const personIdRaw = formStr(form.get('person_id'));
  if (personIdRaw !== null) {
    if (!/^\s*[+-]?\d+\s*$/.test(personIdRaw)) {
      errors.push({
        type: 'int_parsing',
        loc: ['body', 'person_id'],
        msg: 'Input should be a valid integer, unable to parse string as an integer',
        input: personIdRaw,
      });
    } else {
      personId = Number.parseInt(personIdRaw, 10);
    }
  }
  if (errors.length || !(file instanceof File)) return pydanticErrors(errors);

  const surname = formStr(form.get('surname'));
  const name = formStr(form.get('name'));
  const patronymic = formStr(form.get('patronymic'));
  const birthDate = formStr(form.get('birth_date'));
  const note = formStr(form.get('note'));

  // Расширение берётся от последней точки в ИМЕНИ КАК ПРИШЛО — как rsplit в Python.
  const filename = file.name || '';
  const suffix = filename.includes('.')
    ? `.${filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()}`
    : '';
  if (!ALLOWED_EXT.has(suffix)) return badRequest(`Неподдерживаемый формат: ${suffix || '?'}`);

  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > MAX_BYTES) return badRequest('Файл больше 30 МБ');

  let person: { id: number };
  if (personId) {
    // `if person_id:` в Python — 0 уходит в ветку создания, а не в поиск.
    const found = await prisma.pii_persons.findUnique({ where: { id: personId } });
    if (!found) return notFound('Сотрудник не найден');
    person = found;
  } else {
    // Проверяется сырое значение: ФИО из одних пробелов Python тоже пропускает.
    if (!(surname && name)) {
      return badRequest('Не указан person_id и нет ФИО для создания группы');
    }
    const bd = parseBirthDate(birthDate);
    if (bd === BAD_DATE) return badRequest('Неверный формат даты рождения');

    const fio = normalizeFio({ surname, name, patronymic });
    const existing = await prisma.pii_persons.findFirst({ where: { ...fio, birth_date: bd } });
    if (existing) {
      person = existing;
    } else {
      person = await prisma.pii_persons.create({ data: { ...fio, birth_date: bd } });
      await piiLog(gate.user.id, 'create_person', { entity: 'person', entityId: person.id });
    }
  }

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
    person_id: person.id,
    document: {
      id: doc.id,
      filename: doc.original_filename,
      size_bytes: doc.size_bytes,
      uploaded_at: isoUtc(doc.uploaded_at),
    },
  });
}
