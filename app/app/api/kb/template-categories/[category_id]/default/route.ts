import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireKbEditor } from '@/lib/auth';
import { internalError, jsonBody, parsePathId, pyInt } from '@/lib/kb';

// Шаблон по умолчанию для категории.
// Порт POST /api/kb/template-categories/{category_id}/default из backend/routes/kb.py.

type Ctx = { params: Promise<{ category_id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).category_id, 'category_id');
  if ('response' in parsed) return parsed.response;

  const parsedBody = await jsonBody(request);
  if ('response' in parsedBody) return parsedBody.response;
  const body = parsedBody.body;

  const cat =
    parsed.value === null
      ? null
      : await prisma.template_categories.findUnique({
          where: { id: parsed.value },
          select: { id: true },
        });
  if (!cat) return notFound('Категория не найдена');

  const raw = body.template_id;
  let defaultTemplateId: number | null = null;

  // null/отсутствие — снять шаблон по умолчанию; иначе шаблон обязан
  // принадлежать этой же категории.
  if (raw !== null && raw !== undefined) {
    const templateId = pyInt(raw);
    if (templateId === null) return internalError(); // SQLAlchemy упал бы на приведении типа
    const tpl =
      templateId >= -2147483648 && templateId <= 2147483647
        ? await prisma.doc_templates.findUnique({
            where: { id: templateId },
            select: { category_id: true },
          })
        : null;
    if (!tpl || tpl.category_id !== cat.id) {
      return badRequest('Шаблон не принадлежит этой категории');
    }
    defaultTemplateId = templateId;
  }

  await prisma.template_categories.update({
    where: { id: cat.id },
    data: { default_template_id: defaultTemplateId },
  });
  return NextResponse.json({ success: true });
}
