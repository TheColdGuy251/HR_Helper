import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import { readForm, requireFile, uploadSuffix, withTempFile } from '@/lib/docs/common';
import { extractProcessGraph, renderProcessSvg } from '@/lib/docs/processes';
import { baseName, stemOf } from '@/lib/news';

// А10: приведение схем процессов к единому виду (docx/pptx/xlsx → SVG).
// Порт POST /api/documents/process/render из backend/routes/documents.py.
//
// Детерминированно, без LLM; файл не сохраняется. Старые .doc/.ppt/.xls
// конвертируются LibreOffice прямо здесь — в FastAPI ничего не проксируется.

const PROCESS_EXT = new Set(['.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xlsm', '.xls']);

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const form = await readForm(request);
  if ('response' in form) return form.response;
  const file = requireFile(form.form);
  if (file instanceof NextResponse) return file;

  const suffix = uploadSuffix(file);
  if (!PROCESS_EXT.has(suffix)) {
    return badRequest(`Неподдерживаемый формат схемы: ${suffix || '?'}`);
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > 30 * 1024 * 1024) return badRequest('Файл больше 30 МБ');

  const graph = await withTempFile(suffix, data, (tmp) => extractProcessGraph(tmp));
  if (graph === null) {
    return NextResponse.json(
      {
        detail:
          'Не удалось распознать схему: в файле нет блоков со стрелками ' +
          '(если схема — картинка/скан, векторно преобразовать её нельзя)',
      },
      { status: 422 }
    );
  }
  if (!graph.title) {
    // «!процесс вакансии ИИ.docx» → «Процесс вакансии»
    const raw = stemOf(baseName(file.name || 'схема'));
    const stem = raw.replace(/^[!_ ]+/, '').replace(/\s*ИИ\s*$/, '').trim();
    const chars = Array.from(stem);
    graph.title = chars.length ? chars[0].toUpperCase() + chars.slice(1).join('') : null;
  }
  const svg = renderProcessSvg(graph);
  return NextResponse.json({
    success: true,
    title: graph.title,
    svg,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    roles: graph.nodes.filter((n) => n.role).length,
  });
}
