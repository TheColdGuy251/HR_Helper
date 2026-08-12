import { NextResponse } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { asDict, asList, baseName, isoDate, pyBool, reviewStatus } from '@/lib/kb';

// Список документов базы знаний.
// Порт GET /api/kb/documents из backend/routes/kb.py (list_documents).

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const docs = await prisma.kb_documents.findMany({ orderBy: { created_at: 'desc' } });

  return NextResponse.json({
    success: true,
    items: docs.map((d) => {
      const extra = asDict(d.extra);
      return {
        id: d.id,
        title: d.title,
        // Имя файла: сначала то, что сохранил индексатор, иначе — из пути.
        filename:
          (typeof extra.filename === 'string' && extra.filename) ||
          (d.source_type === 'local' && d.source_uri ? baseName(d.source_uri) : null),
        source_type: d.source_type,
        source_uri: d.source_uri,
        status: d.status,
        priority: d.priority,
        document_kind: d.document_kind,
        issuer: d.issuer,
        effective_from: isoDate(d.effective_from),
        effective_to: isoDate(d.effective_to),
        tags: asList(d.tags),
        is_archived: d.is_archived,
        review_status: reviewStatus(d),
        chunks_count: d.chunks_count,
        // Живой прогресс индексации лежит в памяти Python-процесса
        // (services/rag/indexer._progress) и отсюда недоступен — всегда null.
        progress: null,
        ocr_applied: pyBool(extra.ocr_applied),
        // А8: признаки ПДн в документе общей БЗ ({fio_count, reason, samples})
        pii_warning: extra.pii_warning ?? null,
        created_at: isoUtc(d.created_at),
        indexed_at: isoUtc(d.indexed_at),
        error: d.error,
      };
    }),
  });
}
