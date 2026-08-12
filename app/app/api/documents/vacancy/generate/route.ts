import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import { parseFile } from '@/lib/parsers';
import {
  DocValueError,
  docLinks,
  errText,
  readForm,
  requireFile,
  uploadSuffix,
  withTempFile,
} from '@/lib/docs/common';
import { createVacancy } from '@/lib/docs/vacancy';

// Б6: должностная инструкция → текст вакансии для job-сайтов.
// Порт POST /api/documents/vacancy/generate из backend/routes/documents.py.
//
// Файл не сохраняется в базе знаний.

const DI_EXT = new Set(['.docx', '.doc', '.pdf', '.rtf', '.txt', '.odt']);

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const form = await readForm(request);
  if ('response' in form) return form.response;
  const file = requireFile(form.form);
  if (file instanceof NextResponse) return file;

  const suffix = uploadSuffix(file);
  if (!DI_EXT.has(suffix)) {
    return badRequest(`Неподдерживаемый формат инструкции: ${suffix || '?'}`);
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > 15 * 1024 * 1024) return badRequest('Файл больше 15 МБ');

  let diText: string;
  try {
    const parsed = await withTempFile(suffix, data, (tmp) => parseFile(tmp));
    diText = parsed.text;
  } catch (e) {
    return badRequest(`Не удалось распарсить файл: ${errText(e)}`);
  }

  try {
    const { rec, text, meta } = await createVacancy(gate.user.id, diText);
    return NextResponse.json({
      success: true,
      document_id: rec.id,
      title: rec.title,
      ...docLinks(rec.id),
      text,
      position: meta.position,
      section_found: meta.section_found,
    });
  } catch (e) {
    if (e instanceof DocValueError) return badRequest(e.message);
    return NextResponse.json(
      { detail: `Не удалось сформировать вакансию: ${errText(e)}` },
      { status: 500 }
    );
  }
}
