import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import PizZip from 'pizzip';
import { prisma } from '@/lib/db';
import { badRequest, requireKbEditor } from '@/lib/auth';
import { DOCS_DIR, baseName, stemOf, suffixOf, toDocsPath, validationError } from '@/lib/news';
import { indexPendingFile } from '@/lib/ml/indexer';

// Импорт документов из файловой выгрузки 1С (ZIP-архив).
// Порт POST /api/kb/import/1c из backend/routes/kb.py (import_1c_documents).
//
// ФОРМАТЫ, КОТОРЫЕ NEXT НЕ РАЗБИРАЕТ (pdf, doc, xls, odt, ods, ppt, odp), из
// архива всё равно сохраняются и заводятся pending-записью — как в Python.
// Отдельный файл при загрузке через /api/kb/upload проксируется в FastAPI, но
// для архива такой путь невозможен: пришлось бы делить один ZIP на два
// бэкенда и сводить счётчики. Поэтому такие документы индексатор честно
// переведёт в failed с причиной («PDF разбирает PyMuPDF…»), а счётчики
// queued/skipped/ids останутся один-в-один с Python: skipped считает только
// чужой формат, превышение размера и битые элементы архива.

/** settings.docs_local — туда же кладёт файлы FastAPI. */
const DOCS_LOCAL = path.join(DOCS_DIR, 'local');

const KB_IMPORT_EXT = new Set([
  '.pdf', '.docx', '.doc', '.txt', '.md', '.rst', '.csv', '.xlsx', '.xlsm',
  '.rtf', '.odt', '.xls', '.ods', '.pptx', '.ppt', '.odp',
]);
const KB_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const KB_IMPORT_MAX_FILES = 500;

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

/** info.file_size без распаковки: PizZip хранит его в приватном _data. */
function entrySize(entry: object): number | null {
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : null;
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
  if (!(file.name || '').toLowerCase().endsWith('.zip')) {
    return badRequest('Ожидается ZIP-архив выгрузки 1С');
  }

  let zip: PizZip;
  try {
    zip = new PizZip(Buffer.from(await file.arrayBuffer()));
  } catch {
    return badRequest('Файл не является корректным ZIP-архивом');
  }

  await mkdir(DOCS_LOCAL, { recursive: true });

  const queued: number[] = [];
  const jobs: [number, string][] = [];
  let skipped = 0;

  // Порядок ключей PizZip — порядок записей в архиве, как у zf.infolist().
  for (const info of Object.values(zip.files)) {
    if (info.dir) continue;
    if (queued.length >= KB_IMPORT_MAX_FILES) break;

    // Берём только имя файла (защита от путей вида ../../)
    const fname = baseName(info.name);
    if (!fname || !KB_IMPORT_EXT.has(suffixOf(fname).toLowerCase())) {
      skipped += 1;
      continue;
    }
    const size = entrySize(info);
    if (size !== null && size > KB_IMPORT_MAX_FILE_BYTES) {
      skipped += 1;
      continue;
    }

    let content: Buffer;
    try {
      content = info.asNodeBuffer();
    } catch {
      skipped += 1;
      continue;
    }
    if (size === null && content.length > KB_IMPORT_MAX_FILE_BYTES) {
      skipped += 1;
      continue;
    }

    const target = await uniquePath(DOCS_LOCAL, fname);
    let docId: number;
    try {
      await writeFile(target, content);
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
      docId = doc.id;
    } catch {
      // «1С-импорт: пропуск {fname}» — файл не записался или запись не создалась
      skipped += 1;
      continue;
    }

    queued.push(docId);
    jobs.push([docId, target]);
  }

  // В Python задания уходят в пул из ОДНОГО воркера; здесь очередь не нужна —
  // indexPendingFile сериализуется внутренним withIndexLock. after() продлевает
  // жизнь запроса, иначе Next свернёт контекст сразу после ответа.
  after(async () => {
    for (const [docId, target] of jobs) await indexPendingFile(docId, target);
  });

  return NextResponse.json({
    success: true,
    queued: queued.length,
    skipped,
    ids: queued,
  });
}
