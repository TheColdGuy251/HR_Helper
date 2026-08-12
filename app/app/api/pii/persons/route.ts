import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  BAD_DATE,
  modelBody,
  normalizeFio,
  parseBirthDate,
  personPayload,
  piiLog,
  pydanticErrors,
  requirePiiAccess,
  ruDate,
  type PydanticError,
} from '@/lib/pii';

// Поиск карточек сотрудников и создание новой.
// Порт GET/POST /api/pii/persons из backend/routes/pii.py (list_persons, create_person).

export async function GET(request: NextRequest) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  const q = request.nextUrl.searchParams.get('q');
  // Спецсимволы LIKE (% и _) Python не экранирует — Prisma тоже, поведение совпадает.
  // `if q:` в Python — фильтр не включает только пустая строка (пробелы включают).
  const like = q ? q.trim().toLowerCase() : null;
  const where =
    like === null
      ? undefined
      : {
          OR: [
            { surname: { contains: like, mode: 'insensitive' as const } },
            { name: { contains: like, mode: 'insensitive' as const } },
            { patronymic: { contains: like, mode: 'insensitive' as const } },
          ],
        };

  const persons = await prisma.pii_persons.findMany({
    where,
    orderBy: [{ surname: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { pii_documents: true } } },
  });

  const items = persons.map((p) => personPayload(p, { documentsCount: p._count.pii_documents }));

  // Если по ФИО есть полные дубли — добавим в display подсказку с датой рождения
  const fios = new Map<string, number>();
  const keyOf = (it: (typeof items)[number]) => `${it.surname}|${it.name}|${it.patronymic || ''}`;
  for (const it of items) fios.set(keyOf(it), (fios.get(keyOf(it)) ?? 0) + 1);
  for (const it of items) {
    const dup = (fios.get(keyOf(it)) ?? 0) > 1;
    it.full_name_with_dob =
      dup && it.birth_date ? `${it.full_name} (${ruDate(it.birth_date)})` : it.full_name;
  }

  return NextResponse.json({ success: true, items });
}

// ── PersonCreate (pydantic) ────────────────────────────────────────────────

/**
 * Проверка строкового поля с ограничениями Field(min_length/max_length).
 * Отсутствие ключа — «missing» только у обязательных, а вот явный null всегда
 * идёт по ветке типа: у `str` это ошибка, у `str | None` — валидное значение.
 */
function checkStr(
  errors: PydanticError[],
  body: Record<string, unknown>,
  key: string,
  opts: { required: boolean; min?: number; max?: number }
): string | null {
  const value = body[key];
  if (value === undefined) {
    if (opts.required) {
      errors.push({ type: 'missing', loc: ['body', key], msg: 'Field required', input: body });
    }
    return null;
  }
  if (value === null) {
    if (!opts.required) return null;
    errors.push({
      type: 'string_type',
      loc: ['body', key],
      msg: 'Input should be a valid string',
      input: value,
    });
    return null;
  }
  if (typeof value !== 'string') {
    errors.push({
      type: 'string_type',
      loc: ['body', key],
      msg: 'Input should be a valid string',
      input: value,
    });
    return null;
  }
  // pydantic считает длину в кодовых точках, а не в UTF-16.
  const len = Array.from(value).length;
  if (opts.min !== undefined && len < opts.min) {
    errors.push({
      type: 'string_too_short',
      loc: ['body', key],
      msg: `String should have at least ${opts.min} character${opts.min === 1 ? '' : 's'}`,
      input: value,
      ctx: { min_length: opts.min },
    });
    return null;
  }
  if (opts.max !== undefined && len > opts.max) {
    errors.push({
      type: 'string_too_long',
      loc: ['body', key],
      msg: `String should have at most ${opts.max} character${opts.max === 1 ? '' : 's'}`,
      input: value,
      ctx: { max_length: opts.max },
    });
    return null;
  }
  return value;
}

export async function POST(request: NextRequest) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  const parsed = await modelBody(request);
  if ('response' in parsed) return parsed.response;

  const body = parsed.body;
  const errors: PydanticError[] = [];
  const surname = checkStr(errors, body, 'surname', { required: true, min: 1, max: 128 });
  const name = checkStr(errors, body, 'name', { required: true, min: 1, max: 128 });
  const patronymic = checkStr(errors, body, 'patronymic', { required: false, max: 128 });
  const birthDateRaw = checkStr(errors, body, 'birth_date', { required: false });
  // surname/name не могут быть null без ошибки — проверка нужна только компилятору.
  if (errors.length || surname === null || name === null) return pydanticErrors(errors);

  const bd = parseBirthDate(birthDateRaw);
  if (bd === BAD_DATE) return badRequest('Неверный формат даты рождения');

  const fio = normalizeFio({ surname, name, patronymic });

  const existing = await prisma.pii_persons.findFirst({
    where: { ...fio, birth_date: bd },
    include: { _count: { select: { pii_documents: true } } },
  });
  if (existing) {
    return NextResponse.json({
      success: true,
      person: personPayload(existing, { documentsCount: existing._count.pii_documents }),
      created: false,
    });
  }

  const person = await prisma.pii_persons.create({ data: { ...fio, birth_date: bd } });
  await piiLog(gate.user.id, 'create_person', { entity: 'person', entityId: person.id });

  return NextResponse.json({
    success: true,
    person: personPayload(person, { documentsCount: 0 }),
    created: true,
  });
}
