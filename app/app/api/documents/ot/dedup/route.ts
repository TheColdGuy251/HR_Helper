import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import { baseName, suffixOf } from '@/lib/news';
import { parseFile } from '@/lib/parsers';
import { DocValueError, errText, readForm, requireFile, withTempFile } from '@/lib/docs/common';
import { readZipEntries, type ZipEntry } from '@/lib/docs/zip';
import { readSevenZipEntries } from '@/lib/docs/sevenzip';
import { runDedup } from '@/lib/docs/ot-dedup';

// Б7: ZIP или 7z с инструкциями по ОТ → пары с процентом совпадения текста,
// группы однотипных и xlsx-отчёт. Детерминированно, без LLM.
// Порт POST /api/documents/ot/dedup из backend/routes/documents.py;
// 7z добавлен по отзыву УРП от 21.07 (их архив был «охрана труда.7z»).

const ALLOWED = new Set(['.docx', '.doc', '.pdf', '.rtf', '.txt', '.odt']);
const MAX_FILES = 500;

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const form = await readForm(request);
  if ('response' in form) return form.response;
  const file = requireFile(form.form);
  if (file instanceof NextResponse) return file;

  const lowerName = (file.name || '').toLowerCase();
  const isSevenZip = lowerName.endsWith('.7z');
  if (!isSevenZip && !lowerName.endsWith('.zip')) {
    return badRequest('Ожидается ZIP- или 7z-архив с инструкциями (docx/doc/pdf/rtf/txt)');
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > 300 * 1024 * 1024) return badRequest('Архив больше 300 МБ');

  let entries: ZipEntry[];
  try {
    entries = isSevenZip ? await readSevenZipEntries(data) : readZipEntries(data);
  } catch (e) {
    return badRequest(`Не удалось обработать архив: ${errText(e)}`);
  }

  // Отбираем те же записи, что и Python: каталоги и посторонние расширения
  // пропускаются, счёт идёт до 500 файлов.
  const picked: { name: string; suffix: string; read: () => Buffer }[] = [];
  for (const entry of entries) {
    if (entry.dir || picked.length >= MAX_FILES) continue;
    const fname = baseName(entry.name);
    const suffix = suffixOf(fname).toLowerCase();
    if (!fname || !ALLOWED.has(suffix)) continue;
    picked.push({ name: fname, suffix, read: entry.read });
  }

  // Все расширения из ALLOWED разбираются здесь же (PDF — unpdf, сканы —
  // Tesseract, старый Office — LibreOffice), поэтому в FastAPI ничего не
  // уходит. Файл, который всё-таки не прочитался, попадёт в `unreadable`.
  const docs: [string, string][] = [];
  const errors: string[] = [];
  for (const item of picked) {
    try {
      const parsed = await withTempFile(item.suffix, item.read(), (tmp) => parseFile(tmp));
      if ((parsed.text || '').trim()) docs.push([item.name, parsed.text]);
      else errors.push(item.name);
    } catch {
      errors.push(item.name); // [OT-DEDUP] файл не распарсился
    }
  }

  try {
    const { rec, result } = await runDedup(gate.user.id, docs, errors);
    return NextResponse.json({
      success: true,
      document_id: rec.id,
      download_url: `/api/documents/${rec.id}/download`,
      files: result.files,
      duplicates: result.duplicates,
      unreadable: result.unreadable.slice(0, 20),
      pairs: result.pairs.slice(0, 200),
      groups: result.groups.slice(0, 50),
    });
  } catch (e) {
    // В Python здесь оба except дают 400 — и ValueError, и любая другая ошибка.
    if (e instanceof DocValueError) return badRequest(e.message);
    return badRequest(`Не удалось обработать архив: ${errText(e)}`);
  }
}
