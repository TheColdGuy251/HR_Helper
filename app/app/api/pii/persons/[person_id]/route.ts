import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { notFound } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { parseIntParam } from '@/lib/news';
import { deleteStoredFile, personPayload, piiLog, requirePiiAccess } from '@/lib/pii';

// Карточка сотрудника: просмотр (с записью в аудит) и удаление вместе с файлами.
// Порт GET/DELETE /api/pii/persons/{person_id} из backend/routes/pii.py.

type Ctx = { params: Promise<{ person_id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  const parsed = parseIntParam((await params).person_id, 'person_id');
  if ('response' in parsed) return parsed.response;

  const person = await prisma.pii_persons.findUnique({
    where: { id: parsed.value },
    // Python сортирует документы уже в памяти; id — тай-брейкер, чтобы порядок
    // при совпадающем uploaded_at был таким же стабильным, как у sorted().
    include: { pii_documents: { orderBy: [{ uploaded_at: 'desc' }, { id: 'asc' }] } },
  });
  if (!person) return notFound('Сотрудник не найден');

  await piiLog(gate.user.id, 'view_person', { entity: 'person', entityId: person.id });

  return NextResponse.json({
    success: true,
    person: personPayload(person, { documents: person.pii_documents }),
  });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  const parsed = parseIntParam((await params).person_id, 'person_id');
  if ('response' in parsed) return parsed.response;

  const person = await prisma.pii_persons.findUnique({
    where: { id: parsed.value },
    include: { pii_documents: { select: { storage_filename: true } } },
  });
  if (!person) return notFound('Сотрудник не найден');

  // Удаляем зашифрованные файлы с диска
  for (const d of person.pii_documents) await deleteStoredFile(d.storage_filename);
  // Записи документов уходят каскадом по внешнему ключу (ON DELETE CASCADE).
  await prisma.pii_persons.delete({ where: { id: person.id } });

  await piiLog(gate.user.id, 'delete_person', { entity: 'person', entityId: parsed.value });
  return NextResponse.json({ success: true });
}
