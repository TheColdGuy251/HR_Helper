import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import { parseFile } from '@/lib/parsers';
import { errText, readForm, requireFile, uploadSuffix, withTempFile } from '@/lib/docs/common';
import { parsePetition } from '@/lib/docs/characteristic';

// Б1, шаг 1: парсинг ходатайства о награждении и извлечение полей для проверки.
// Порт POST /api/documents/characteristic/analyze из backend/routes/documents.py.
//
// Файл эфемерный: он НЕ сохраняется и НЕ попадает в базу знаний — там
// персональные данные.

const PETITION_EXT = new Set(['.docx', '.doc', '.rtf', '.pdf', '.txt', '.odt']);

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const form = await readForm(request);
  if ('response' in form) return form.response;
  const file = requireFile(form.form);
  if (file instanceof NextResponse) return file;

  const suffix = uploadSuffix(file);
  if (!PETITION_EXT.has(suffix)) {
    return badRequest(`Неподдерживаемый формат ходатайства: ${suffix || '?'}`);
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > 15 * 1024 * 1024) return badRequest('Файл больше 15 МБ');

  let text: string;
  try {
    const parsed = await withTempFile(suffix, data, (tmp) => parseFile(tmp));
    text = (parsed.text || '').trim();
  } catch (e) {
    return badRequest(`Не удалось распарсить файл: ${errText(e)}`);
  }
  if (!text) return badRequest('Не удалось извлечь текст из ходатайства');

  const fields = await parsePetition(text, gate.user.id);
  return NextResponse.json({ success: true, fields });
}
