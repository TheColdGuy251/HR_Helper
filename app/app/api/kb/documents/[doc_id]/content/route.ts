import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, conflict, notFound, requireKbEditor } from '@/lib/auth';
import { jsonBody, parsePathId, pyBool, pyStr } from '@/lib/kb';
import { reindexContent } from '@/lib/ml/indexer';

// Извлечённый текст документа для редактора (А6) и его правка.
// Порт GET/PATCH /api/kb/documents/{doc_id}/content из backend/routes/kb.py.

type Ctx = { params: Promise<{ doc_id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).doc_id, 'doc_id');
  if ('response' in parsed) return parsed.response;

  const doc =
    parsed.value === null
      ? null
      : await prisma.kb_documents.findUnique({
          where: { id: parsed.value },
          select: { content: true, title: true },
        });
  if (!doc) return notFound('Документ не найден');

  return NextResponse.json({ success: true, content: doc.content || '', title: doc.title });
}

/**
 * Заменяет извлечённый текст документа и переиндексирует его в фоне (статус и
 * прогресс — как при обычной загрузке). Название и метаданные сохраняются;
 * исходный файл на диске НЕ меняется — правка живёт в базе знаний.
 */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).doc_id, 'doc_id');
  if ('response' in parsed) return parsed.response;

  const parsedBody = await jsonBody(request);
  if ('response' in parsedBody) return parsedBody.response;

  // str(body.get("content") or "").strip()
  const rawContent = parsedBody.body.content;
  const text = pyStr(pyBool(rawContent) ? rawContent : '').trim();
  if (text.length < 20) return badRequest('Текст слишком короткий (минимум 20 символов)');
  if (text.length > 5_000_000) return badRequest('Текст больше 5 млн символов');

  const doc =
    parsed.value === null
      ? null
      : await prisma.kb_documents.findUnique({ where: { id: parsed.value } });
  if (!doc) return notFound('Документ не найден');
  if (doc.status === 'pending' || doc.status === 'parsing') {
    return conflict('Документ сейчас индексируется — дождитесь завершения');
  }

  await prisma.kb_documents.update({
    where: { id: doc.id },
    data: { status: 'pending', error: null },
  });

  // after() продлевает жизнь запроса: переиндексация (эмбеддинги + Qdrant)
  // идёт уже после ответа, как поток-демон в Python.
  after(async () => {
    await reindexContent(doc.id, text);
  });

  return NextResponse.json({ success: true, status: 'pending' });
}
