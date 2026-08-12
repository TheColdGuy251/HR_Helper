import { mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireUser } from '@/lib/auth';
import { DOCS_DIR, suffixOf } from '@/lib/kb';
import { toDocsPath, validationError } from '@/lib/news';
import { parseFile, type ParsedFile } from '@/lib/parsers';

// Вложение файла в чат-сессию (эфемерное, в базу знаний не уходит).
// Порт POST /api/chat/upload-document из backend/routes/chat.py
// (upload_session_document).
//
// Запись создаётся с message_id = NULL — это очередь «ожидающих» вложений,
// которую /api/chat/stream подхватит при следующей отправке сообщения.
//
// ВАЖНО: форматы, которые Next разобрать не может (PDF, старый Office — см.
// lib/parsers), целиком проксируются в FastAPI. Сохранить их с пустым текстом
// нельзя: Python на пустой текст отвечает 400, а вложение без содержимого
// бесполезно как контекст для модели. Решение принимается ДО записи в БД и на
// диск, по расширению — иначе получилась бы дублирующая запись.

/** settings.docs_dir / "session_files" — туда же кладёт оригиналы FastAPI. */
const SESSION_FILES_DIR = path.join(DOCS_DIR, 'session_files');

const ALLOWED_SUFFIXES = new Set([
  '.pdf', '.docx', '.doc', '.txt', '.md', '.csv', '.rtf', '.odt',
  '.xls', '.xlsx', '.xlsm', '.ods', '.pptx', '.ppt', '.odp', '.zip',
]);
const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // 20 МБ
const MAX_ATTACH_PER_SESSION = 5;

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  // Тело читаем в буфер: если формат не наш, тот же байт-в-байт запрос уходит
  // в FastAPI, а второй раз прочитать поток нельзя.
  const raw = await request.arrayBuffer();
  let form: FormData;
  try {
    form = await new Response(raw, {
      headers: { 'content-type': request.headers.get('content-type') || '' },
    }).formData();
  } catch {
    return validationError(['body', 'session_id'], 'missing', 'Field required', null);
  }

  // Порядок проверок — как в сигнатуре FastAPI: сначала session_id, потом file.
  const sessionId = form.get('session_id');
  if (typeof sessionId !== 'string') {
    return validationError(['body', 'session_id'], 'missing', 'Field required', null);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return validationError(['body', 'file'], 'missing', 'Field required', null);
  }

  const session = await prisma.chat_sessions.findUnique({
    where: { id: sessionId },
    select: { id: true, dialogues: { select: { user_id: true } } },
  });
  if (!session || session.dialogues.user_id !== user.id) return notFound('Сессия не найдена');

  const suffix = suffixOf(file.name || '').toLowerCase();
  if (!ALLOWED_SUFFIXES.has(suffix)) return badRequest(`Неподдерживаемый формат: ${suffix}`);

  const existing = await prisma.session_documents.count({ where: { session_id: sessionId } });
  if (existing >= MAX_ATTACH_PER_SESSION) {
    return badRequest(`Лимит вложений на сессию: ${MAX_ATTACH_PER_SESSION}`);
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const size = buf.byteLength;
  if (size > MAX_ATTACH_BYTES) return badRequest('Файл больше 20 МБ');

  // Парсеры работают с путём, поэтому кладём файл во временный, как и Python.
  const tmpPath = path.join(os.tmpdir(), `${randomUUID().replace(/-/g, '')}${suffix}`);
  await writeFile(tmpPath, buf);
  try {
    let text: string;
    let mime: string | null;

    // ZIP — контейнер для пакетных инструментов (дубликаты инструкций ОТ):
    // текст не извлекаем, храним только оригинал.
    if (suffix === '.zip') {
      text = `[ZIP-архив: ${file.name || 'архив'}]`;
      mime = 'application/zip';
    } else {
      let parsed: ParsedFile;
      try {
        parsed = await parseFile(tmpPath);
      } catch (e) {
        return badRequest(`Не удалось распарсить файл: ${e instanceof Error ? e.message : String(e)}`);
      }
      text = (parsed.text || '').trim();
      mime = parsed.meta.mime_type;
      if (!text) {
        return badRequest(
          'Текст из файла извлечь не удалось (возможно, скан без OCR-распознавания)'
        );
      }
    }

    // Сохраняем ОРИГИНАЛ каждого вложения: точные преобразования (отчёт по
    // ДПО, справка, опись, «Форма 2», схемы, ZIP) работают по исходному файлу,
    // а не по извлечённому тексту. Файл удаляется вместе с вложением.
    await mkdir(SESSION_FILES_DIR, { recursive: true });
    const storedPath = path.join(SESSION_FILES_DIR, `${randomUUID().replace(/-/g, '')}${suffix}`);
    await writeFile(storedPath, buf);

    const doc = await prisma.session_documents.create({
      data: {
        session_id: sessionId,
        filename: file.name || path.basename(tmpPath),
        mime_type: mime,
        size_bytes: size,
        content: text,
        char_count: [...text].length, // len() в Python считает кодовые точки
        stored_path: toDocsPath(storedPath),
      },
      select: { id: true, filename: true, size_bytes: true, char_count: true },
    });

    return NextResponse.json({
      success: true,
      file: {
        id: doc.id,
        name: doc.filename,
        size: doc.size_bytes,
        chars: doc.char_count,
      },
    });
  } finally {
    await unlink(tmpPath).catch(() => undefined); // missing_ok=True
  }
}
