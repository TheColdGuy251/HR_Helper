import type { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { intQuery, parsePathId } from '@/lib/kb';
import { kbDocumentView, viewResponse } from '@/lib/file-view';

/**
 * Контекст просмотра документа базы знаний.
 * Порт GET /kb/documents/{doc_id}/view?format=json из backend/routes/pages.py.
 *
 * Почему адрес /api/view/…, а не как в Python: путь /kb/documents/{id}/view
 * занят Next-страницей (app/kb/documents/[id]/view/page.tsx), а страницу и
 * route handler на один путь не повесить. Страница ходит сюда за JSON.
 *
 * Авторизация: в Python это require_user_redirect (HTML-страница уводит на
 * логин), здесь запрос делает fetch — отдаём 401 JSON, а на логин уводит клиент.
 */

type Ctx = { params: Promise<{ doc_id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).doc_id, 'doc_id');
  if ('response' in parsed) return parsed.response;

  // diff/text/original — `int | None = None` в сигнатуре роута FastAPI.
  const sp = request.nextUrl.searchParams;
  const diff = intQuery(sp.get('diff'), 'diff');
  if ('response' in diff) return diff.response;
  const text = intQuery(sp.get('text'), 'text');
  if ('response' in text) return text.response;
  const original = intQuery(sp.get('original'), 'original');
  if ('response' in original) return original.response;

  return viewResponse(
    await kbDocumentView(parsed.value, gate.user, {
      diff: diff.value,
      text: text.value,
      original: original.value,
    })
  );
}
