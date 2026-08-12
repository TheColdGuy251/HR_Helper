import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireKbEditor } from '@/lib/auth';
import { internalError, jsonBody, parsePathId, pyBool, pyInt } from '@/lib/kb';
import { deleteKbDocument } from '@/lib/ml/indexer';

// Правка и удаление веб-источника базы знаний.
// Порт PATCH/DELETE /api/kb/sources/{source_id} из backend/routes/kb.py
// (patch_source, delete_source).

type Ctx = { params: Promise<{ source_id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).source_id, 'source_id');
  if ('response' in parsed) return parsed.response;

  const parsedBody = await jsonBody(request);
  if ('response' in parsedBody) return parsedBody.response;
  const body = parsedBody.body;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  const src =
    parsed.value === null
      ? null
      : await prisma.kb_sources.findUnique({ where: { id: parsed.value }, select: { id: true } });
  if (!src) return notFound('Источник не найден');

  const data: Prisma.kb_sourcesUncheckedUpdateInput = {};

  if (has('priority')) {
    const p = pyInt(body.priority);
    if (p === null) return internalError(); // int(...) в Python бросил бы исключение
    if (p !== 1 && p !== 2 && p !== 3) return badRequest('priority должен быть 1, 2 или 3');
    data.priority = p;
  }

  if (has('is_enabled')) data.is_enabled = pyBool(body.is_enabled);

  if (Object.keys(data).length) {
    await prisma.kb_sources.update({ where: { id: src.id }, data });
  }
  return NextResponse.json({ success: true });
}

/**
 * Удаление источника вместе с его проиндексированными документами: без этого в
 * поиске остались бы «призраки» — векторы Qdrant, BM25 и граф kb_links.
 * Отсутствующий источник ошибкой не считается — ответ всегда success.
 */
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).source_id, 'source_id');
  if ('response' in parsed) return parsed.response;

  const src =
    parsed.value === null
      ? null
      : await prisma.kb_sources.findUnique({ where: { id: parsed.value } });
  if (src) {
    const docs = await prisma.kb_documents.findMany({
      where: { source_uri: src.url, source_type: 'web' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const d of docs) {
      try {
        await deleteKbDocument(d.id);
      } catch {
        /* «Не удалось удалить документ источника» — сам источник всё равно сносим */
      }
    }
    await prisma.kb_sources.delete({ where: { id: src.id } });
  }
  return NextResponse.json({ success: true });
}
