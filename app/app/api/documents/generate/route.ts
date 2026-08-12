import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { isFile } from '@/lib/kb';
import { toDocsPath } from '@/lib/news';
import { detectPiiDocument, modelBody, pydanticErrors, type PydanticError } from '@/lib/pii';
import { GENERATED_DIR, timestamp } from '@/lib/docs/common';
import { renderTemplateBuffer, safeFilename, templatePath } from '@/lib/docs/generator';

// Генерация документа по шаблону.
// Порт POST /api/documents/generate из backend/routes/documents.py.
//
// Сам рендер (render_template: docxtpl-шаблон или бланк-«пустографка») живёт в
// lib/docs/generator.ts — тем же кодом пользуется генерация внутри диалога.

interface ValidBody {
  template_key: string;
  fields: Record<string, unknown>;
  title: string | null;
}

/** Проверка GenerateDocRequest: pydantic отдаёт все ошибки разом. */
function validate(body: Record<string, unknown>): ValidBody | PydanticError[] {
  const errors: PydanticError[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  if (!has('template_key') || body.template_key === null || body.template_key === undefined) {
    errors.push({ type: 'missing', loc: ['body', 'template_key'], msg: 'Field required', input: body });
  } else if (typeof body.template_key !== 'string') {
    errors.push({
      type: 'string_type',
      loc: ['body', 'template_key'],
      msg: 'Input should be a valid string',
      input: body.template_key,
    });
  }

  if (!has('fields') || body.fields === null || body.fields === undefined) {
    errors.push({ type: 'missing', loc: ['body', 'fields'], msg: 'Field required', input: body });
  } else if (typeof body.fields !== 'object' || Array.isArray(body.fields)) {
    errors.push({
      type: 'dict_type',
      loc: ['body', 'fields'],
      msg: 'Input should be a valid dictionary',
      input: body.fields,
    });
  }

  const title = body.title;
  if (title !== undefined && title !== null && typeof title !== 'string') {
    errors.push({
      type: 'string_type',
      loc: ['body', 'title'],
      msg: 'Input should be a valid string',
      input: title,
    });
  }

  if (errors.length) return errors;
  return {
    template_key: body.template_key as string,
    fields: body.fields as Record<string, unknown>,
    title: (title as string | undefined) ?? null,
  };
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsedBody = await modelBody(request);
  if ('response' in parsedBody) return parsedBody.response;

  const checked = validate(parsedBody.body);
  if (Array.isArray(checked)) return pydanticErrors(checked);

  const tpl = await prisma.doc_templates.findFirst({ where: { key: checked.template_key } });
  if (!tpl) return notFound(`Шаблон '${checked.template_key}' не найден`);

  const src = templatePath(tpl.file_path);
  if (!(await isFile(src))) {
    // FileNotFoundError внутри render_template ловит `except Exception` в роуте.
    return NextResponse.json(
      { detail: `Не удалось сгенерировать документ: Шаблон не найден: ${src}` },
      { status: 500 }
    );
  }

  const content = await readFile(src);
  const outName = `${safeFilename(tpl.key)}_${timestamp()}.docx`;
  const outPath = path.join(GENERATED_DIR, outName);

  try {
    const result = renderTemplateBuffer(content, checked.fields);
    await mkdir(GENERATED_DIR, { recursive: true });
    await writeFile(outPath, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { detail: `Не удалось сгенерировать документ: ${msg}` },
      { status: 500 }
    );
  }

  const created = await prisma.my_documents.create({
    data: {
      user_id: gate.user.id,
      title: checked.title || tpl.title,
      template_key: checked.template_key,
      file_path: toDocsPath(outPath),
      progress: 100,
      status: 'ready',
      fields: checked.fields as Prisma.InputJsonValue,
      // ПДн-документы не храним: пометка включает скрытие из «Моих документов»
      // и автоудаление по TTL (pii_cleanup).
      is_pii: detectPiiDocument(checked.template_key, Object.values(checked.fields)),
    },
  });

  return NextResponse.json({
    success: true,
    document_id: created.id,
    file_path: created.file_path,
  });
}
