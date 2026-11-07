import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { notFound } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { parseIdParam } from '@/lib/news';
import { deleteStoredFile, personPayload, piiLog, requirePiiAccess } from '@/lib/pii';

// Карточка сотрудника: просмотр (с записью в аудит) и удаление вместе с файлами.

type Ctx = { params: Promise<{ person_id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  const parsed = parseIdParam((await params).person_id, 'person_id');
  if ('response' in parsed) return parsed.response;

  const person = await prisma.pii_persons.findUnique({
    where: { id: parsed.value },
    // id - тай-брейкер: при совпадающем uploaded_at порядок остаётся
    // стабильным.
    include: { documents: { orderBy: [{ uploaded_at: 'desc' }, { id: 'asc' }] } },
  });
  if (!person) return notFound('Сотрудник не найден');

  await piiLog(gate.user.id, 'view_person', { entity: 'person', entityId: person.id });

  return NextResponse.json({
    success: true,
    person: personPayload(person, { documents: person.documents }),
  });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  const parsed = parseIdParam((await params).person_id, 'person_id');
  if ('response' in parsed) return parsed.response;

  const person = await prisma.pii_persons.findUnique({
    where: { id: parsed.value },
    include: { documents: { select: { storage_filename: true } } },
  });
  if (!person) return notFound('Сотрудник не найден');

  // Удаляем зашифрованные файлы с диска
  for (const d of person.documents) await deleteStoredFile(d.storage_filename);
  // Записи документов уходят каскадом по внешнему ключу (ON DELETE CASCADE).
  await prisma.pii_persons.delete({ where: { id: person.id } });

  await piiLog(gate.user.id, 'delete_person', { entity: 'person', entityId: parsed.value });
  return NextResponse.json({ success: true });
}
