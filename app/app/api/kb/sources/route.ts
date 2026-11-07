import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { badRequest, requireKbEditor, requireUser } from '@/lib/auth';
import { internalError, jsonBody, pyBool, pyInt, pyStr } from '@/lib/kb';
import { indexUrl } from '@/lib/ml/indexer';

// Веб-источники базы знаний: список и добавление.

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const items = await prisma.kb_sources.findMany({ orderBy: { id: 'asc' } });

  // Проиндексированный документ для каждого URL (для предпросмотра "что распарсилось").
  const docs = await prisma.kb_documents.findMany({
    where: { source_type: 'web' },
    orderBy: { id: 'desc' },
    select: { id: true, source_uri: true, status: true, chunks_count: true },
  });
  const docByUrl = new Map<string, (typeof docs)[number]>();
  for (const d of docs) {
    if (!docByUrl.has(d.source_uri)) docByUrl.set(d.source_uri, d); // самый свежий (id desc)
  }

  return NextResponse.json({
    success: true,
    items: items.map((s) => {
      const d = docByUrl.get(s.url);
      return {
        id: s.id,
        name: s.name,
        url: s.url,
        is_enabled: s.is_enabled,
        priority: s.priority,
        refresh_interval_hours: s.refresh_interval_hours,
        last_crawled_at: isoUtc(s.last_crawled_at),
        // Строка для показа: "ok" или "error: <текст>" - как было до разделения
        // статуса и текста ошибки по колонкам.
        last_status: s.last_status === 'error' ? `error: ${s.last_error ?? ''}` : s.last_status,
        last_error: s.last_error,
        document_id: d ? d.id : null,
        doc_status: d ? d.status : null,
        chunks_count: d ? d.chunks_count : 0,
      };
    }),
  });
}

export async function POST(request: NextRequest) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = await jsonBody(request);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;

  const name = body.name;
  const url = body.url;
  if (!pyBool(name) || !pyBool(url)) return badRequest('name и url обязательны');

  const hours = pyInt(pyBool(body.refresh_interval_hours) ? body.refresh_interval_hours : 24);
  if (hours === null) return internalError();
  if (hours < 1) return badRequest('refresh_interval_hours должен быть положительным');

  const target = pyStr(url);
  const src = await prisma.kb_sources.create({
    data: {
      name: pyStr(name),
      url: target,
      refresh_interval_hours: hours,
    },
  });

  // Начинаем парсинг сразу (в фоне), не дожидаясь планировщика.
  after(async () => {
    // Итог обхода: статус ok/error и текст ошибки - в отдельных колонках.
    let result: { last_status: 'ok' | 'error'; last_error: string | null };
    try {
      await indexUrl(target);
      result = { last_status: 'ok', last_error: null };
    } catch (e) {
      result = { last_status: 'error', last_error: String(e instanceof Error ? e.message : e) || 'ошибка' };
    }
    await prisma.kb_sources
      .update({ where: { id: src.id }, data: { ...result, last_crawled_at: new Date() } })
      .catch(() => undefined); // источник успели удалить
  });

  return NextResponse.json({ success: true, id: src.id, queued: true });
}
