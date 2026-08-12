import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireKbEditor } from '@/lib/auth';
import {
  asList,
  internalError,
  isoDate,
  jsonBody,
  parsePathId,
  parsePyDate,
  pyBool,
  pyInt,
  pyStr,
} from '@/lib/kb';
import { deleteKbDocument } from '@/lib/ml/indexer';
import { invalidateBlankCatalog } from '@/lib/ml/blank-forms';
import { setDocumentPayload } from '@/lib/ml/qdrant';

// Правка метаданных и удаление документа базы знаний.
// Порт PATCH/DELETE /api/kb/documents/{doc_id} из backend/routes/kb.py.

const KINDS = new Set(['code', 'law', 'regulation', 'order', 'manual', 'other']);
const DATE_FIELDS = ['effective_from', 'effective_to'] as const;

type Ctx = { params: Promise<{ doc_id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).doc_id, 'doc_id');
  if ('response' in parsed) return parsed.response;

  const parsedBody = await jsonBody(request);
  if ('response' in parsedBody) return parsedBody.response;
  const body = parsedBody.body;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  const doc =
    parsed.value === null
      ? null
      : await prisma.kb_documents.findUnique({ where: { id: parsed.value } });
  if (!doc) return notFound('Документ не найден');

  const data: Prisma.kb_documentsUncheckedUpdateInput = {};

  if (has('priority')) {
    const p = pyInt(body.priority);
    if (p === null) return internalError(); // int(...) в Python бросил бы исключение
    if (p !== 1 && p !== 2 && p !== 3) return badRequest('priority должен быть 1, 2 или 3');
    data.priority = p;
  }

  // Внимание: пустая строка не проходит проверку, а «   » — проходит и
  // обнуляет название после strip(). Повторяем как есть.
  if (has('title') && pyBool(body.title)) data.title = pyStr(body.title).trim();

  if (has('document_kind')) {
    const v = body.document_kind;
    if (v === null || v === undefined || v === '' || v === 'none') data.document_kind = null;
    else if (typeof v === 'string' && KINDS.has(v)) data.document_kind = v;
    else return badRequest('document_kind: code|law|regulation|order|manual|other');
  }

  if (has('issuer')) {
    data.issuer = pyBool(body.issuer) ? pyStr(body.issuer).trim() || null : null;
  }

  for (const fld of DATE_FIELDS) {
    if (!has(fld)) continue;
    const v = body[fld];
    let value: Date | null = null;
    if (pyBool(v)) {
      value = parsePyDate(pyStr(v).trim());
      if (!value) return badRequest(`${fld}: формат YYYY-MM-DD`);
    }
    if (fld === 'effective_from') data.effective_from = value;
    else data.effective_to = value;
  }

  if (has('tags')) {
    const raw = pyBool(body.tags) ? body.tags : [];
    if (!Array.isArray(raw)) return badRequest('tags должен быть массивом строк');
    const tags = raw.map((t) => pyStr(t).trim()).filter((t) => t).slice(0, 20);
    data.tags = tags.length ? tags : Prisma.DbNull;
  }

  if (has('is_archived')) data.is_archived = pyBool(body.is_archived);

  const saved = Object.keys(data).length
    ? await prisma.kb_documents.update({ where: { id: doc.id }, data })
    : doc;

  // Синхронизация payload чанков в Qdrant (порт routes/kb.py:300 и :347).
  // Поиск фильтрует по payload, а не по БД: без синхронизации архивная
  // редакция оставалась бы в выдаче, а приоритет не влиял бы на ранжирование
  // до полной переиндексации. Недоступный Qdrant правку метаданных не роняет —
  // как и в Python, ошибка только пишется в лог.
  if (has('priority')) {
    try {
      await setDocumentPayload(doc.id, { priority: saved.priority });
    } catch (e) {
      console.warn(`Qdrant set_priority failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (has('tags') || has('is_archived') || has('document_kind') || has('title')) {
    try {
      await setDocumentPayload(doc.id, {
        is_archived: Boolean(saved.is_archived),
        document_kind: saved.document_kind,
        tags: asList(saved.tags),
        // Название тоже уходит в payload: цитаты и бейджи источников читают его
        // из чанков, и после правки в /kb они не должны показывать старое.
        ...(has('title') ? { title: saved.title } : {}),
      });
    } catch (e) {
      console.warn(`Qdrant payload sync failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Каталог карточек «Связанные документы» держит названия в памяти процесса.
  if (has('title')) invalidateBlankCatalog();

  return NextResponse.json({
    success: true,
    document: {
      id: saved.id,
      title: saved.title,
      priority: saved.priority,
      document_kind: saved.document_kind,
      issuer: saved.issuer,
      effective_from: isoDate(saved.effective_from),
      effective_to: isoDate(saved.effective_to),
      tags: asList(saved.tags),
      is_archived: saved.is_archived,
    },
  });
}

/**
 * Удаление документа: векторы Qdrant, kb_links, файл на диске и запись в БД,
 * затем перестройка BM25 (порт delete_document из services/rag/indexer.py).
 * Отсутствующий документ ошибкой не считается — Python тоже отвечает success.
 */
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).doc_id, 'doc_id');
  if ('response' in parsed) return parsed.response;

  if (parsed.value !== null) await deleteKbDocument(parsed.value);
  return NextResponse.json({ success: true });
}
