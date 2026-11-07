import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { asUuid } from '@/lib/ids';
import { badRequest, notFound, requireKbEditor } from '@/lib/auth';
import { invalidateBlankCatalog } from '@/lib/ml/blank-forms';
import {
  asList,
  internalError,
  jsonBody,
  parsePathId,
  pyBool,
  pyInt,
  pyStr,
  TEMPLATES_DIR,
  uuidError,
} from '@/lib/kb';

// Правка и удаление шаблона HR-документа.

type Ctx = { params: Promise<{ template_id: string }> };
type Field = Record<string, unknown>;

/**
 * Точечная правка схемы полей: мержим по имени поля, новых полей не заводим -
 * так управляется поведение "спрашивать недостающее" и "пустое вместо null".
 * Поля без имени выпадают из схемы.
 */
function mergeFields(current: unknown, incoming: unknown[]): Field[] {
  const existing = new Map<unknown, Field>();
  for (const f of asList(current)) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const name = (f as Field).name;
    if (pyBool(name)) existing.set(name, { ...(f as Field) });
  }

  for (const item of incoming) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const patch = item as Field;
    // Ключ ищем строкой: поле с нестроковым именем не найдётся.
    const f = existing.get(pyBool(patch.name) ? pyStr(patch.name).trim() : '');
    if (!f) continue;
    if (Object.prototype.hasOwnProperty.call(patch, 'required')) f.required = pyBool(patch.required);
    // "optional" - синоним-антоним для удобства фронта
    if (Object.prototype.hasOwnProperty.call(patch, 'optional')) f.required = !pyBool(patch.optional);
    if (pyBool(patch.type)) f.type = pyStr(patch.type);
    if (pyBool(patch.label)) f.label = pyStr(patch.label);
    if (Object.prototype.hasOwnProperty.call(patch, 'hint')) f.hint = patch.hint;
  }

  return [...existing.values()];
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).template_id, 'template_id');
  if ('response' in parsed) return parsed.response;

  const parsedBody = await jsonBody(request);
  if ('response' in parsedBody) return parsedBody.response;
  const body = parsedBody.body;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  const tpl = await prisma.doc_templates.findUnique({ where: { id: parsed.value } });
  if (!tpl) return notFound('Шаблон не найден');

  const data: Prisma.doc_templatesUncheckedUpdateInput = {};

  if (has('category_id')) {
    const raw = body.category_id;
    let cid: string | null = null;
    if (raw !== null && raw !== undefined) {
      cid = asUuid(raw);
      if (cid === null) return uuidError(['body', 'category_id'], raw);
      const cat = await prisma.template_categories.findUnique({ where: { id: cid }, select: { id: true } });
      if (!cat) return badRequest('Категория не найдена');
    }
    data.category_id = cid;
    // "По умолчанию" относится к категории: при переносе в другую флаг снимается
    // (иначе в новой категории могло бы оказаться два шаблона по умолчанию).
    if (cid !== tpl.category_id) data.is_default = false;
  }

  // Название сохраняется без trim().
  if (has('title') && pyBool(body.title)) data.title = pyStr(body.title);

  if (has('description')) {
    const v = body.description;
    data.description = v === null || v === undefined ? null : pyStr(v);
  }

  if (has('is_enabled')) data.is_enabled = pyBool(body.is_enabled);

  if (has('fields')) {
    const incoming = body.fields;
    if (!Array.isArray(incoming)) return badRequest('fields должен быть массивом объектов');
    data.fields_schema = mergeFields(tpl.fields_schema, incoming) as unknown as Prisma.InputJsonValue;
  }

  if (Object.keys(data).length) {
    await prisma.doc_templates.update({ where: { id: tpl.id }, data });
    // Название/доступность бланка изменились - каталог карточек в памяти устарел.
    invalidateBlankCatalog();
  }
  return NextResponse.json({ success: true });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).template_id, 'template_id');
  if ('response' in parsed) return parsed.response;

  const tpl =
    parsed.value === null
      ? null
      : await prisma.doc_templates.findUnique({
          where: { id: parsed.value },
          select: { id: true, file_path: true },
        });
  if (!tpl) return notFound('Шаблон не найден');

  // Файл сносим "молча": ошибки удаления проглатываются.
  // Относительный путь достраиваем от docs/templates - у Next другой CWD,
  // и без этого удалился бы файл не оттуда.
  const file = path.isAbsolute(tpl.file_path)
    ? tpl.file_path
    : path.join(TEMPLATES_DIR, tpl.file_path);
  await unlink(file).catch(() => {});

  // default_template_id у категорий обнулится каскадом (ON DELETE SET NULL).
  await prisma.doc_templates.delete({ where: { id: tpl.id } });
  return NextResponse.json({ success: true });
}
