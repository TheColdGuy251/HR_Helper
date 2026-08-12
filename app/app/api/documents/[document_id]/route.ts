import { unlink } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { asList, internalError, jsonBody, parsePathId, pyStr } from '@/lib/kb';
import { resolveInsideDocs } from '@/lib/news';
import { generateJsonOrMock } from '@/lib/ml/llm-json';
import { SYSTEM_PROMPT_EXTRACT } from '@/lib/ml/prompts';

// Удаление сгенерированного документа + LLM-извлечение полей шаблона.
// Порт DELETE /api/documents/{document_id} и POST /api/documents/extract-fields
// из backend/routes/documents.py (+ extract_fields_with_llm из
// services/documents/generator.py).

type Ctx = { params: Promise<{ document_id: string }> };

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).document_id, 'document_id');
  if ('response' in parsed) return parsed.response;

  // Общий доступ: любой сотрудник может удалить документ (по #2).
  const doc =
    parsed.value === null
      ? null
      : await prisma.my_documents.findUnique({ where: { id: parsed.value } });
  if (!doc) return notFound('Документ не найден');

  // Удаляем файл, если он внутри docs/ (path-traversal-safe)
  if (doc.file_path) {
    const file = resolveInsideDocs(doc.file_path);
    if (file) await unlink(file).catch(() => undefined);
  }

  await prisma.my_documents.delete({ where: { id: doc.id } });
  return NextResponse.json({ success: true });
}

/**
 * json.dumps({...}, ensure_ascii=False): у Python разделители «, » и «: »,
 * у JSON.stringify — без пробелов. Подсказка идёт в промпт, поэтому формат
 * должен совпадать дословно.
 */
function schemaHint(schema: unknown[]): string | null {
  const parts: string[] = [];
  for (const f of schema) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return null; // TypeError в Python
    const item = f as Record<string, unknown>;
    if (!('name' in item)) return null; // KeyError в Python
    const type = 'type' in item ? item.type : 'string';
    parts.push(`${JSON.stringify(pyStr(item.name))}: ${JSON.stringify(type)}`);
  }
  return `{${parts.join(', ')}}`;
}

/**
 * POST на этом пути обслуживает /api/documents/extract-fields: Next
 * сопоставляет маршрут по ПУТИ, и статический сегмент попадает в динамический
 * [document_id]. На реальные id метода POST нет ни здесь, ни в Python —
 * отвечаем тем же 405, что отдал бы Starlette, не привлекая FastAPI.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  if ((await params).document_id !== 'extract-fields') {
    return NextResponse.json({ detail: 'Method Not Allowed' }, { status: 405 });
  }

  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const body = await jsonBody(request);
  if ('response' in body) return body.response;

  const templateKey = body.body.template_key;
  const tpl =
    typeof templateKey === 'string'
      ? await prisma.doc_templates.findFirst({ where: { key: templateKey } })
      : null;
  if (!tpl) return notFound('Шаблон не найден');

  const hint = schemaHint(asList(tpl.fields_schema));
  if (hint === null) return internalError();

  const extractionPrompt =
    tpl.extraction_prompt || 'Извлеките значения полей для шаблона документа из приведённого текста.';
  const userText = 'text' in body.body ? pyStr(body.body.text) : '';

  const fields = await generateJsonOrMock(
    SYSTEM_PROMPT_EXTRACT,
    `${extractionPrompt}\n\nТекст:\n${userText}`,
    hint,
    gate.user.id
  );
  return NextResponse.json({ success: true, fields });
}
