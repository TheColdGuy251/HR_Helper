import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireKbEditor } from '@/lib/auth';
import { asUuid } from '@/lib/ids';
import { jsonBody, parsePathId, uuidError } from '@/lib/kb';

// Шаблон по умолчанию для категории.
//
// Раньше это была ссылка template_categories.default_template_id, теперь -
// флаг doc_templates.is_default: частичный уникальный индекс в БД не даёт
// отметить два шаблона одной категории.

type Ctx = { params: Promise<{ category_id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).category_id, 'category_id');
  if ('response' in parsed) return parsed.response;

  const parsedBody = await jsonBody(request);
  if ('response' in parsedBody) return parsedBody.response;
  const body = parsedBody.body;

  const cat = await prisma.template_categories.findUnique({
    where: { id: parsed.value },
    select: { id: true },
  });
  if (!cat) return notFound('Категория не найдена');

  const raw = body.template_id;
  let templateId: string | null = null;

  // null/отсутствие - снять шаблон по умолчанию; иначе шаблон обязан
  // принадлежать этой же категории.
  if (raw !== null && raw !== undefined) {
    templateId = asUuid(raw);
    if (templateId === null) return uuidError(['body', 'template_id'], raw);
    const tpl = await prisma.doc_templates.findUnique({
      where: { id: templateId },
      select: { category_id: true },
    });
    if (!tpl || tpl.category_id !== cat.id) {
      return badRequest('Шаблон не принадлежит этой категории');
    }
  }

  // Сначала снимаем прежний флаг, затем ставим новый - одной транзакцией,
  // иначе уникальный индекс увидел бы два шаблона по умолчанию.
  await prisma.$transaction([
    prisma.doc_templates.updateMany({
      where: { category_id: cat.id, is_default: true },
      data: { is_default: false },
    }),
    ...(templateId
      ? [prisma.doc_templates.update({ where: { id: templateId }, data: { is_default: true } })]
      : []),
  ]);
  return NextResponse.json({ success: true });
}
