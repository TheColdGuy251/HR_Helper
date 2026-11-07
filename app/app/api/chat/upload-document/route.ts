import { mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, requireUser } from '@/lib/auth';
import { DOCS_DIR, suffixOf } from '@/lib/kb';
import { validationError } from '@/lib/news';
import { requireOwnDialogue } from '@/lib/chat';
import { parseFile, type ParsedFile } from '@/lib/parsers';

// Вложение файла в диалог с ассистентом (эфемерное, в базу знаний не уходит).
//
// Запись создаётся с message_id = NULL - это очередь "ожидающих" вложений,
// которую /api/chat/stream подхватит при следующей отправке сообщения.

/** Каталог оригиналов вложений чата: docs_dir/session_files. */
const SESSION_FILES_DIR = path.join(DOCS_DIR, 'session_files');

const ALLOWED_SUFFIXES = new Set([
  '.pdf', '.docx', '.doc', '.txt', '.md', '.csv', '.rtf', '.odt',
  '.xls', '.xlsx', '.xlsm', '.ods', '.pptx', '.ppt', '.odp', '.zip', '.7z',
]);
const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // 20 МБ
const MAX_ATTACH_PER_DIALOGUE = 5;

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const raw = await request.arrayBuffer();
  let form: FormData;
  try {
    form = await new Response(raw, {
      headers: { 'content-type': request.headers.get('content-type') || '' },
    }).formData();
  } catch {
    return validationError(['body', 'dialogue_id'], 'missing', 'Field required', null);
  }

  // Порядок проверок: сначала диалог, потом file.
  const dialogueRaw = form.get('dialogue_id');
  if (typeof dialogueRaw !== 'string') {
    return validationError(['body', 'dialogue_id'], 'missing', 'Field required', null);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return validationError(['body', 'file'], 'missing', 'Field required', null);
  }

  const own = await requireOwnDialogue(dialogueRaw, user.id, ['body', 'dialogue_id']);
  if ('response' in own) return own.response;
  const dialogueId = own.id;

  const suffix = suffixOf(file.name || '').toLowerCase();
  if (!ALLOWED_SUFFIXES.has(suffix)) return badRequest(`Неподдерживаемый формат: ${suffix}`);

  const existing = await prisma.chat_attachments.count({ where: { dialogue_id: dialogueId } });
  if (existing >= MAX_ATTACH_PER_DIALOGUE) {
    return badRequest(`Лимит вложений на диалог: ${MAX_ATTACH_PER_DIALOGUE}`);
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const size = buf.byteLength;
  if (size > MAX_ATTACH_BYTES) return badRequest('Файл больше 20 МБ');

  // Парсеры работают с путём, поэтому кладём файл во временный.
  const tmpPath = path.join(os.tmpdir(), `${randomUUID().replace(/-/g, '')}${suffix}`);
  await writeFile(tmpPath, buf);
  try {
    let text: string;
    let mime: string | null;

    // ZIP/7z - контейнеры для пакетных инструментов (дубликаты инструкций ОТ):
    // текст не извлекаем, храним только оригинал.
    if (suffix === '.zip' || suffix === '.7z') {
      text = `[Архив: ${file.name || 'архив'}]`;
      mime = suffix === '.zip' ? 'application/zip' : 'application/x-7z-compressed';
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

    // Сохраняем оригинал каждого вложения: точные преобразования (отчёт по
    // ДПО, справка, опись, "Форма 2", схемы, ZIP) работают по исходному файлу,
    // а не по извлечённому тексту. Файл удаляется вместе с вложением.
    await mkdir(SESSION_FILES_DIR, { recursive: true });
    const storedPath = path.join(SESSION_FILES_DIR, `${randomUUID().replace(/-/g, '')}${suffix}`);
    await writeFile(storedPath, buf);

    const doc = await prisma.chat_attachments.create({
      data: {
        dialogue_id: dialogueId,
        filename: file.name || path.basename(tmpPath),
        mime_type: mime,
        size_bytes: size,
        content: text,
        stored_path: storedPath,
      },
      select: { id: true, filename: true, size_bytes: true },
    });

    return NextResponse.json({
      success: true,
      file: {
        id: doc.id,
        name: doc.filename,
        size: doc.size_bytes,
        chars: [...text].length, // число кодовых точек
      },
    });
  } finally {
    await unlink(tmpPath).catch(() => undefined); // missing_ok=True
  }
}
