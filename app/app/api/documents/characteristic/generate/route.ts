import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import { jsonBody } from '@/lib/kb';
import { docLinks, errText } from '@/lib/docs/common';
import { createCharacteristic, petitionFieldsFromJson } from '@/lib/docs/characteristic';

// Б1, шаг 2: генерация характеристики по (возможно поправленным) полям.
// Порт POST /api/documents/characteristic/generate из backend/routes/documents.py.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const body = await jsonBody(request);
  if ('response' in body) return body.response;

  const fields = petitionFieldsFromJson(body.body.fields ?? {});
  if (!fields.fio && !fields.achievements) {
    return badRequest('Нужны хотя бы ФИО или текст достижений из ходатайства');
  }

  const category = typeof body.body.category === 'string' ? body.body.category : null;
  try {
    const { rec, text } = await createCharacteristic(gate.user.id, fields, category);
    return NextResponse.json({
      success: true,
      document_id: rec.id,
      title: rec.title,
      ...docLinks(rec.id),
      text,
    });
  } catch (e) {
    return NextResponse.json(
      { detail: `Не удалось сформировать характеристику: ${errText(e)}` },
      { status: 500 }
    );
  }
}
