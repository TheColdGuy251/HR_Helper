import { requireUser } from '@/lib/auth';
import { parsePathId } from '@/lib/kb';
import { myDocumentView, viewResponse } from '@/lib/file-view';

/**
 * Контекст просмотра документа пользователя («Мои документы») — те же режимы.
 * Порт GET /documents/{doc_id}/view?format=json из backend/routes/pages.py.
 * Про адрес /api/view/… см. комментарий в соседнем kb-document/route.ts.
 */

type Ctx = { params: Promise<{ document_id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).document_id, 'document_id');
  if ('response' in parsed) return parsed.response;

  return viewResponse(await myDocumentView(parsed.value));
}
