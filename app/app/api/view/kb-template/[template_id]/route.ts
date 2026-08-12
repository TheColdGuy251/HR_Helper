import { requireUser } from '@/lib/auth';
import { parsePathId } from '@/lib/kb';
import { kbTemplateView, viewResponse } from '@/lib/file-view';

/**
 * Контекст просмотра шаблона документа (.docx — docx-preview, .pdf — нативно).
 * Порт GET /kb/templates/{template_id}/view?format=json из backend/routes/pages.py.
 * Про адрес /api/view/… см. комментарий в соседнем kb-document/route.ts.
 */

type Ctx = { params: Promise<{ template_id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).template_id, 'template_id');
  if ('response' in parsed) return parsed.response;

  return viewResponse(await kbTemplateView(parsed.value));
}
