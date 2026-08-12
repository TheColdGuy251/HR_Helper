import { requireUser } from '@/lib/auth';
import { parsePathId } from '@/lib/kb';
import { newsMediaView, viewResponse } from '@/lib/file-view';

/**
 * Контекст просмотра файла, прикреплённого к новости (pdf/docx/xlsx/txt/… —
 * как в мессенджере, через общий buildViewCtx).
 * Порт GET /news/media/{media_id}/view?format=json из backend/routes/pages.py.
 * Про адрес /api/view/… см. комментарий в соседнем kb-document/route.ts.
 */

type Ctx = { params: Promise<{ media_id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).media_id, 'media_id');
  if ('response' in parsed) return parsed.response;

  return viewResponse(await newsMediaView(parsed.value));
}
