import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireKbEditor } from '@/lib/auth';
import { jsonBody, pyBool, pyStr } from '@/lib/kb';
import { indexUrl } from '@/lib/ml/indexer';

// Индексация веб-страницы по URL.
// Порт POST /api/kb/index-url из backend/routes/kb.py (index_url).
//
// Ответ ждёт окончания индексации, как и в Python: скачивание, разбор,
// эмбеддинги и запись в Qdrant идут прямо в обработчике.

export async function POST(request: NextRequest) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = await jsonBody(request);
  if ('response' in parsed) return parsed.response;

  const url = parsed.body.url;
  if (!pyBool(url)) return badRequest('URL не указан');

  try {
    const doc = await indexUrl(pyStr(url));
    return NextResponse.json({
      success: true,
      document: { id: doc.id, title: doc.title, chunks: doc.chunks_count },
    });
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e);
    return NextResponse.json(
      { detail: `Не удалось проиндексировать URL: ${detail}` },
      { status: 500 }
    );
  }
}
