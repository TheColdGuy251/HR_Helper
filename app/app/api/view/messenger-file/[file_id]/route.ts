import { requireUser } from '@/lib/auth';
import { parsePathId } from '@/lib/kb';
import { messengerFileView, viewResponse } from '@/lib/file-view';

/**
 * Контекст просмотра файла из мессенджера (pdf/docx/xlsx/текст — как в /kb).
 * Порт GET /messenger/files/{file_id}/view?format=json из backend/routes/pages.py.
 *
 * Прав доступа к конкретному файлу здесь нет — как и в Python: страница
 * требует только авторизации, а участие в диалоге проверяет уже отдача байтов
 * (/api/messenger/files/{id}). Расхождение сохранено сознательно, чтобы
 * поведение совпадало 1-в-1; см. отчёт по переносу.
 */

type Ctx = { params: Promise<{ file_id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).file_id, 'file_id');
  if ('response' in parsed) return parsed.response;

  return viewResponse(await messengerFileView(parsed.value));
}
