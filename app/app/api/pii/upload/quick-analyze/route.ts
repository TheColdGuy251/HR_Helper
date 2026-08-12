import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { validationError } from '@/lib/news';
import { parseFile } from '@/lib/parsers';
import { isoDate, personPayload, piiLog, requirePiiAccess, type PersonPayload } from '@/lib/pii';
import { recognizePerson } from '@/lib/pii-recognize';

// Быстрая загрузка: разбираем документ, распознаём ФИО + дату рождения и
// возвращаем «кандидатов» — существующих людей с похожим ФИО. Файл не
// сохраняется, фронт отдаст его ещё раз на /upload/commit.
// Порт POST /api/pii/upload/quick-analyze из backend/routes/pii.py.
//
// ВАЖНО: PDF, сканы и старый .doc в Next не разбираются (см. lib/parsers) —
// такой запрос целиком уходит в FastAPI, который сам распознает и запишет
// строку в аудит. Решение принимается по расширению, ДО чтения формы в File.

const MAX_BYTES = 30 * 1024 * 1024; // 30 МБ
const ANALYZABLE_EXT = new Set([
  '.pdf', '.docx', '.doc', '.txt', '.md',
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff',
]);

export async function POST(request: NextRequest) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  // Тело читаем в буфер: если формат не наш, тот же байт-в-байт запрос уходит
  // в FastAPI, а второй раз прочитать поток нельзя.
  const raw = await request.arrayBuffer();
  let form: FormData;
  try {
    form = await new Response(raw, {
      headers: { 'content-type': request.headers.get('content-type') || '' },
    }).formData();
  } catch {
    return validationError(['body', 'file'], 'missing', 'Field required', null);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return validationError(['body', 'file'], 'missing', 'Field required', null);
  }

  // Расширение берётся от последней точки в ИМЕНИ КАК ПРИШЛО — как rsplit в Python.
  const filename = file.name || '';
  const suffix = filename.includes('.')
    ? `.${filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()}`
    : '';
  if (!ANALYZABLE_EXT.has(suffix)) {
    return badRequest(
      `Формат «${suffix}» нельзя проанализировать. Используйте /persons/{id}/documents.`
    );
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > MAX_BYTES) return badRequest('Файл больше 30 МБ');

  // parse_file работает с путём — кладём во временный файл с тем же расширением.
  const tmp = path.join(tmpdir(), `pii-${randomUUID().replace(/-/g, '')}${suffix}`);
  let text = '';
  try {
    await writeFile(tmp, data);
    try {
      const parsed = await parseFile(tmp);
      text = parsed.text || '';
    } catch (e) {
      return badRequest(
        `Не удалось распарсить файл: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }

  const recognized = await recognizePerson(text);

  // Кандидаты в БД: ilike без «%» — это точное совпадение без учёта регистра.
  let candidates: PersonPayload[] = [];
  if (recognized.surname) {
    const rows = await prisma.pii_persons.findMany({
      where: recognized.name
        ? {
            surname: { equals: recognized.surname, mode: 'insensitive' },
            name: { equals: recognized.name, mode: 'insensitive' },
          }
        : { surname: { equals: recognized.surname, mode: 'insensitive' } },
      take: 10,
      include: { _count: { select: { pii_documents: true } } },
    });
    candidates = rows.map((p) => personPayload(p, { documentsCount: p._count.pii_documents }));
  }

  await piiLog(gate.user.id, 'quick_analyze', { extra: { filename } });

  return NextResponse.json({
    success: true,
    filename,
    recognized: {
      surname: recognized.surname,
      name: recognized.name,
      patronymic: recognized.patronymic,
      birth_date: isoDate(recognized.birth_date),
    },
    candidates,
  });
}
