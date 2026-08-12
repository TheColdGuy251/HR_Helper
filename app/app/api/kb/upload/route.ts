import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, requireKbEditor } from '@/lib/auth';
import { DOCS_DIR, baseName, stemOf, suffixOf, toDocsPath, validationError } from '@/lib/news';
import { indexPendingFile } from '@/lib/ml/indexer';

// Загрузка документа в базу знаний.
// Порт POST /api/kb/upload из backend/routes/kb.py (upload).
//
// Все разрешённые форматы разбираются здесь же (PDF, сканы под OCR и старый
// Office — см. lib/parsers), поэтому проксирование в FastAPI осталось только
// как страховка на случай новых расширений в ALLOWED. Решение принимается ДО
// сохранения файла, по расширению: дублировать запись в БД нельзя.

/** settings.docs_local — туда же кладёт файлы FastAPI. */
const DOCS_LOCAL = path.join(DOCS_DIR, 'local');

const ALLOWED = new Set([
  '.pdf', '.docx', '.doc', '.txt', '.md', '.rst', '.csv', '.xlsx', '.xlsm',
  '.rtf', '.odt', '.xls', '.ods', '.pptx', '.ppt', '.odp',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff',
]);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Не перезатираем уже существующий файл с тем же именем (порт _unique_path). */
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

  const name = baseName(file.name || '');
  const suffix = suffixOf(name).toLowerCase();
  if (!ALLOWED.has(suffix)) return badRequest(`Неподдерживаемый формат: ${suffix}`);

  await mkdir(DOCS_LOCAL, { recursive: true });
  const target = await uniquePath(DOCS_LOCAL, name || 'document');
  await writeFile(target, Buffer.from(await file.arrayBuffer()));

  // Создаём pending-запись синхронно (сразу видна в списке), а тяжёлый
  // парсинг/эмбеддинги уносим в фон — ответ не ждёт индексации.
  const doc = await prisma.kb_documents.create({
    data: {
      title: baseName(target),
      source_type: 'local',
      source_uri: toDocsPath(target),
      status: 'pending',
      // Значения по умолчанию из модели SQLAlchemy (в схеме Prisma их нет).
      priority: 2,
      is_archived: false,
      chunks_count: 0,
    },
  });

  // after() продлевает жизнь запроса до завершения работы — без него Next
  // может свернуть контекст сразу после ответа и убить индексацию.
  after(async () => {
    await indexPendingFile(doc.id, target);
  });

  return NextResponse.json({
    success: true,
    queued: true,
    document: { id: doc.id, title: doc.title, status: 'pending' },
  });
}
