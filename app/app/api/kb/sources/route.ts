import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { badRequest, requireKbEditor, requireUser } from '@/lib/auth';
import { internalError, jsonBody, pyBool, pyInt, pyStr } from '@/lib/kb';
import { indexUrl } from '@/lib/ml/indexer';

// Веб-источники базы знаний: список и добавление.
// Порт GET/POST /api/kb/sources из backend/routes/kb.py (list_sources, create_source).

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const items = await prisma.kb_sources.findMany({ orderBy: { id: 'asc' } });

  // Проиндексированный документ для каждого URL (для предпросмотра «что распарсилось»).
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
        last_status: s.last_status,
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
  if (hours === null) return internalError(); // int(...) в Python бросил бы исключение

  const target = pyStr(url);
  const src = await prisma.kb_sources.create({
    data: {
      name: pyStr(name),
      url: target,
      refresh_interval_hours: hours,
      // Значений по умолчанию в схеме нет — повторяем default'ы модели KBSource.
      is_enabled: true,
      priority: 2,
    },
  });

  // Начинаем парсинг СРАЗУ (в фоне), не дожидаясь планировщика. Порт
  // _index_url_background: статус источника обновляется, ошибки не роняют сервис.
  after(async () => {
    let status: string;
    try {
      await indexUrl(target);
      status = 'ok';
    } catch (e) {
      status = `error: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`;
    }
    const fresh = await prisma.kb_sources.findUnique({ where: { id: src.id } });
    if (!fresh) return; // источник успели удалить
    await prisma.kb_sources
      .update({ where: { id: src.id }, data: { last_crawled_at: new Date(), last_status: status } })
      .catch(() => undefined); // last_status — VARCHAR(32): длинный текст ошибки не влезет (как и в Python)
  });

  return NextResponse.json({ success: true, id: src.id, queued: true });
}
