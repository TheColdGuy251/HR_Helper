import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { notFound, requireKbEditor } from '@/lib/auth';
import { asList, jsonBody, parsePathId, pyBool, pyStr } from '@/lib/kb';
import { invalidateFaqMatcher } from '@/lib/ml/faq';

// Правка и удаление FAQ-записи (А2/А6).
// Порт PATCH/DELETE /api/kb/faq/{entry_id} из backend/routes/kb.py.
//
// После каждой записи сбрасываем прогретые прототипы FAQ-матчера (аналог
// get_matcher().invalidate() в Python) — иначе бот продолжает отвечать по
// старым вариантам формулировок до перезапуска процесса. Процесс FastAPI, если
// он ещё поднят, свой кэш не увидит — там сброс делает сам Python-роут.

type Ctx = { params: Promise<{ entry_id: string }> };

/** Python-идиома `str(x or "")`: пустые значения дают пустую строку. */
function strOrEmpty(v: unknown): string {
  return pyBool(v) ? pyStr(v) : '';
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).entry_id, 'entry_id');
  if ('response' in parsed) return parsed.response;

  const parsedBody = await jsonBody(request);
  if ('response' in parsedBody) return parsedBody.response;
  const body = parsedBody.body;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  const row =
    parsed.value === null
      ? null
      : await prisma.faq_entries.findUnique({ where: { id: parsed.value }, select: { id: true } });
  if (!row) return notFound('FAQ-запись не найдена');

  const data: Prisma.faq_entriesUncheckedUpdateInput = {};

  if (has('answer')) data.answer = strOrEmpty(body.answer);
  if (has('contact')) data.contact = pyBool(body.contact) ? pyStr(body.contact).trim() || null : null;

  if (has('variants')) {
    const vs = asList(body.variants)
      .map((v) => pyStr(v).trim())
      .filter((v) => v);
    data.variants = vs.length ? vs : Prisma.DbNull;
  }

  if (has('clarify_question')) data.clarify_question = strOrEmpty(body.clarify_question).trim() || null;
  if (has('option_label')) data.option_label = strOrEmpty(body.option_label).trim() || null;
  if (has('is_active')) data.is_active = pyBool(body.is_active);

  if (Object.keys(data).length) {
    // SQLAlchemy бампает updated_at на каждом UPDATE (onupdate=current_timestamp).
    data.updated_at = new Date();
    await prisma.faq_entries.update({ where: { id: row.id }, data });
  }
  invalidateFaqMatcher(); // прототипы пересчитаются при следующем запросе
  return NextResponse.json({ success: true });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parsePathId((await params).entry_id, 'entry_id');
  if ('response' in parsed) return parsed.response;

  const row =
    parsed.value === null
      ? null
      : await prisma.faq_entries.findUnique({ where: { id: parsed.value }, select: { id: true } });
  if (!row) return notFound('FAQ-запись не найдена');

  await prisma.faq_entries.delete({ where: { id: row.id } });
  invalidateFaqMatcher();
  return NextResponse.json({ success: true });
}

/**
 * POST по этому пути у FastAPI нет (импорт живёт на статическом /api/kb/faq/import,
 * его перехватывает app/api/kb/faq/import). Starlette в таком случае отвечает 405
 * с заголовком Allow первого маршрута, совпавшего по пути, — это PATCH, он
 * объявлен раньше DELETE. Экспорт нужен, чтобы Next не подставил свой 405
 * (без Allow и без тела) и чтобы запрос не ушёл по fallback-правилу в Python.
 */
export async function POST() {
  return NextResponse.json(
    { detail: 'Method Not Allowed' },
    { status: 405, headers: { Allow: 'PATCH' } }
  );
}
