import 'server-only';
import { prisma } from '@/lib/db';
import { persistAndFinish, type StreamState } from '@/lib/chat';
import { chatStream } from '@/lib/ml/llm';
import { SYSTEM_PROMPT_DOC_REPLY } from '@/lib/ml/prompts';
import { generateDocument } from './generator';
import {
  extractFields,
  fillDefaults,
  isBlank,
  missingRequiredFields,
  pyJson,
  ruFieldLabel,
  summarizeForTitle,
  templateFields,
  validateFields,
  wantsCancel,
  wantsCorrection,
  wantsForceGenerate,
  type DocTemplateLike,
  type FieldValues,
} from './intent';

/**
 * Диалоговая генерация документов по шаблону внутри чата.
 * Порт _handle_document_generation / _docgen_ask_missing / _docgen_render_and_reply /
 * _continue_docgen / _apply_correction из backend/routes/chat.py.
 */

// ---------------------------------------------------------------------------
// Состояние добора полей (в памяти процесса)
// ---------------------------------------------------------------------------
// Когда не хватает обязательных полей, запоминаем шаблон + уже собранные
// значения по session_id; следующее сообщение пользователя досказывает
// недостающее.
//
// ОГРАНИЧЕНИЕ (как и в Python): состояние живёт в памяти процесса. В Python это
// был single-worker uvicorn; в Next — тот же приём через globalThis, чтобы
// пережить hot-reload дев-сервера. Из этого следует:
//  • при нескольких инстансах/воркерах Node состояние НЕ общее — пользователь,
//    попавший на другой инстанс, увидит «не вижу активного оформления»;
//  • при рестарте процесса добор теряется (пользователь повторит команду);
//  • serverless-развёртывание (каждый запрос — новый инстанс) сломает добор
//    полностью — там состояние надо переносить в БД/Redis.
// Осознанно повторяем поведение Python: перенос делаем 1-в-1.

interface PendingDocgen {
  template_key: string;
  fields: FieldValues;
  created_at: number;
}

const g = globalThis as unknown as {
  __hrPendingDocgen?: Map<string, PendingDocgen>;
  __hrLastDocgen?: Map<string, PendingDocgen>;
};

function pendingMap(): Map<string, PendingDocgen> {
  if (!g.__hrPendingDocgen) g.__hrPendingDocgen = new Map();
  return g.__hrPendingDocgen;
}

function lastMap(): Map<string, PendingDocgen> {
  if (!g.__hrLastDocgen) g.__hrLastDocgen = new Map();
  return g.__hrLastDocgen;
}

/** Незавершённый добор живёт 30 минут. */
const PENDING_TTL_MS = 30 * 60 * 1000;

function getFresh(map: Map<string, PendingDocgen>, sessionId: string): PendingDocgen | null {
  const p = map.get(sessionId);
  if (!p) return null;
  if (Date.now() - p.created_at > PENDING_TTL_MS) {
    map.delete(sessionId);
    return null;
  }
  return p;
}

export function setPending(sessionId: string, templateKey: string, fields: FieldValues): void {
  pendingMap().set(sessionId, {
    template_key: templateKey,
    fields: { ...(fields || {}) },
    created_at: Date.now(),
  });
}

export function getPending(sessionId: string): PendingDocgen | null {
  return getFresh(pendingMap(), sessionId);
}

export function clearPending(sessionId: string): void {
  pendingMap().delete(sessionId);
}

// Последний успешно сгенерированный документ в сессии — чтобы поддержать
// исправление полей ПОСЛЕ генерации («имя неправильно — должно быть …»).
// Извлечение дергаем только на сообщениях-исправлениях, поэтому лишних вызовов
// LLM нет.
export function setLastDocgen(sessionId: string, templateKey: string, fields: FieldValues): void {
  lastMap().set(sessionId, {
    template_key: templateKey,
    fields: { ...(fields || {}) },
    created_at: Date.now(),
  });
}

export function getLastDocgen(sessionId: string): PendingDocgen | null {
  return getFresh(lastMap(), sessionId);
}

// ---------------------------------------------------------------------------
// Общие помощники
// ---------------------------------------------------------------------------

/** Подписи полей шаблона: имя → русская подпись для показа пользователю. */
function labeller(template: DocTemplateLike): (name: string) => string {
  const schema = new Map(templateFields(template).map((f) => [f.name, f]));
  return (n: string) => ruFieldLabel(n, schema.get(n)?.label ?? null);
}

async function templateByKey(key: string | undefined): Promise<DocTemplateLike | null> {
  if (!key) return null;
  return prisma.doc_templates.findFirst({ where: { key } });
}

export interface DocgenCtx {
  sessionId: string;
  assistantMessageId: number;
  userId: number;
  state: StreamState;
  setStatus: (stage: string) => void;
}

// ---------------------------------------------------------------------------
// Запрос недостающих полей
// ---------------------------------------------------------------------------

/**
 * Просит у пользователя недостающие обязательные поля и запоминает контекст
 * (шаблон + уже собранные значения) для диалогового добора.
 * `missing` — список ИМЁН полей; подписи для показа переводим на русский.
 */
async function docgenAskMissing(
  template: DocTemplateLike,
  fields: FieldValues,
  missing: string[],
  ctx: DocgenCtx
): Promise<void> {
  ctx.setStatus('generate');
  const label = labeller(template);

  const known: [string, unknown][] = [];
  for (const f of templateFields(template)) {
    if (!isBlank(fields[f.name])) known.push([label(f.name), fields[f.name]]);
  }

  const lines = [`Чтобы оформить «${template.title}», не хватает данных:`];
  lines.push(...missing.map((n) => `- ${label(n)}`));
  if (known.length) {
    lines.push('');
    lines.push('Уже распознано:');
    lines.push(...known.map(([k, v]) => `- ${k}: ${v}`));
  }
  lines.push('');
  lines.push(
    'Напишите недостающие сведения — можно по одному сообщению или все сразу. ' +
      'Можно и исправить уже распознанное (например, «отчество должно быть Алексеевна»). ' +
      'Если нужно оформить без недостающих полей, напишите «сгенерируй как есть».'
  );
  ctx.state.append(lines.join('\n'));
  ctx.state.event.set();

  setPending(ctx.sessionId, template.key, fields);
  await persistAndFinish(ctx.assistantMessageId, ctx.state);
}

// ---------------------------------------------------------------------------
// Рендер и подтверждение
// ---------------------------------------------------------------------------

/**
 * Рендерит .docx по собранным полям, привязывает к сообщению и стримит
 * короткое подтверждение.
 */
async function docgenRenderAndReply(
  template: DocTemplateLike,
  fields: FieldValues,
  ctx: DocgenCtx
): Promise<void> {
  ctx.setStatus('render_doc');
  const docTitle = summarizeForTitle(template, fields);
  let docId: number | null = null;
  try {
    const doc = await generateDocument(ctx.userId, template.key, fields, docTitle);
    docId = doc.id;
  } catch (e) {
    ctx.state.append(
      `Не удалось сгенерировать документ: ${e instanceof Error ? e.message : String(e)}`
    );
    ctx.state.event.set();
    await persistAndFinish(ctx.assistantMessageId, ctx.state);
    return;
  }

  // Готовим короткое подтверждение через LLM (стримим, чтобы UX оставался живым).
  ctx.setStatus('generate');
  const usedFields: FieldValues = {};
  for (const [k, v] of Object.entries(fields)) if (v) usedFields[k] = v;
  const userMsg =
    `Создан документ «${template.title}».\n` +
    `Заполненные поля: ${pyJson(usedFields)}\n\n` +
    'Сообщи это HR-специалисту.';
  try {
    for await (const chunk of chatStream({
      system: SYSTEM_PROMPT_DOC_REPLY,
      user: userMsg,
      maxTokens: 180,
      userId: ctx.userId,
    })) {
      if (ctx.state.cancelled) break;
      ctx.state.append(chunk);
      ctx.state.event.set();
    }
  } catch {
    ctx.state.append(`\nДокумент «${template.title}» сохранён. Файл доступен ниже.`);
  }

  await persistAndFinish(ctx.assistantMessageId, ctx.state, null, docId);
  // Запоминаем последний документ сессии — для исправления полей после генерации.
  setLastDocgen(ctx.sessionId, template.key, fields);
}

// ---------------------------------------------------------------------------
// Первичная обработка запроса на документ
// ---------------------------------------------------------------------------

/**
 * «Оформи приказ», «нанять X» и т.п. Извлекает поля; если не хватает
 * обязательных и пользователь не просил «как есть» — запрашивает недостающее
 * (диалоговый добор), иначе рендерит документ.
 */
export async function handleDocumentGeneration(
  template: DocTemplateLike,
  userText: string,
  ctx: DocgenCtx,
  previewFields: FieldValues | null = null,
  force = false
): Promise<void> {
  let fields: FieldValues = previewFields !== null ? previewFields : {};
  try {
    if (!Object.keys(fields).length) fields = (await extractFields(userText, template)) || {};
    fields = fillDefaults(fields, template);
    // Числовые поля приводим к числу и отбрасываем мусор («пельмени» в оклад).
    fields = validateFields(fields, template);
  } catch {
    /* extract_fields failed — работаем с тем, что уже есть */
  }

  const missing = missingRequiredFields(fields, template);
  if (missing.length && !force) {
    await docgenAskMissing(template, fields, missing, ctx);
    return;
  }

  clearPending(ctx.sessionId);
  await docgenRenderAndReply(template, fields, ctx);
}

// ---------------------------------------------------------------------------
// Продолжение добора
// ---------------------------------------------------------------------------

/**
 * Пользователь досказывает поля для начатой генерации. Возвращает true, если
 * сообщение обработано как продолжение (запрос ещё полей / генерация / отмена);
 * false — если пользователь сменил тему (тогда pending снят и сообщение уходит
 * в обычный поток).
 */
export async function continueDocgen(
  pending: PendingDocgen,
  userText: string,
  ctx: DocgenCtx
): Promise<boolean> {
  const template = await templateByKey(pending.template_key);
  if (!template) {
    clearPending(ctx.sessionId);
    return false;
  }

  // Явная отмена начатого оформления.
  if (wantsCancel(userText)) {
    clearPending(ctx.sessionId);
    ctx.setStatus('generate');
    ctx.state.append(`Хорошо, отменил оформление «${template.title}».`);
    ctx.state.event.set();
    await persistAndFinish(ctx.assistantMessageId, ctx.state);
    return true;
  }

  const force = wantsForceGenerate(userText);
  const isCorrection = wantsCorrection(userText);

  const prior: FieldValues = { ...(pending.fields || {}) };
  // Контекст для извлечения: что уже есть и чего не хватает — чтобы одиночные
  // значения без подписи («Александровна», «лаборант») сопоставились с нужными
  // полями по смыслу, а не потерялись.
  const label = labeller(template);
  const knownDesc =
    Object.entries(prior)
      .filter(([, v]) => !isBlank(v))
      .map(([k, v]) => `${label(k)}=${v}`)
      .join(', ') || '—';
  const missingDesc =
    missingRequiredFields(prior, template)
      .map((n) => `${label(n)} (${n})`)
      .join(', ') || '—';
  const context =
    `Уже заполнено: ${knownDesc}.\n` +
    `Ещё не хватает: ${missingDesc}.\n` +
    'Пользователь досказывает недостающие поля или исправляет ранее указанные. ' +
    'Сопоставляйте одиночные значения без подписи с недостающими полями по смыслу: ' +
    'отчество обычно оканчивается на «-овна/-евна/-ична/-ович/-евич»; ' +
    'должность — существительное-профессия (лаборант, инженер). ' +
    'Заполняйте только те поля, значения которых явно есть в сообщении.';

  let newFields: FieldValues = {};
  try {
    newFields = validateFields((await extractFields(userText, template, context)) || {}, template);
  } catch {
    newFields = {};
  }

  const merged: FieldValues = { ...prior };
  let gotNew = false;
  for (const [k, v] of Object.entries(newFields)) {
    if (isBlank(v)) continue;
    const cur = merged[k];
    if (isBlank(cur)) {
      merged[k] = v; // заполняем пустой слот
      gotNew = true;
    } else if (isCorrection && String(v).trim() !== String(cur).trim()) {
      merged[k] = v; // исправление ранее заполненного поля
      gotNew = true;
    }
  }

  // Fallback: LLM не распознала значение (например, «HR-служба» как подразделение),
  // но не хватает РОВНО ОДНОГО поля и пользователь прислал обычное значение (не
  // вопрос/команда) → это и есть ответ на наш вопрос. Кладём текст прямо в поле.
  if (!gotNew && !force && !isCorrection) {
    const missingNow = missingRequiredFields(prior, template);
    const cleaned = (userText || '').trim();
    if (
      missingNow.length === 1 &&
      cleaned &&
      cleaned.length <= 120 &&
      !cleaned.includes('?') &&
      !wantsCancel(cleaned)
    ) {
      merged[missingNow[0]] = cleaned;
      gotNew = true;
    }
  }

  // Ни одного поля не заполнил/не исправил и не просит «как есть» → он сменил
  // тему: снимаем pending и отдаём сообщение обычному потоку (RAG/чат).
  if (!gotNew && !force) {
    clearPending(ctx.sessionId);
    return false;
  }

  const filled = fillDefaults(merged, template);
  const missing = missingRequiredFields(filled, template);
  if (missing.length && !force) {
    await docgenAskMissing(template, filled, missing, ctx);
    return true;
  }

  clearPending(ctx.sessionId);
  await docgenRenderAndReply(template, filled, ctx);
  return true;
}

// ---------------------------------------------------------------------------
// Исправление уже созданного документа
// ---------------------------------------------------------------------------

/**
 * «Имя неправильно — должно быть …» ПОСЛЕ генерации: перегенерирует документ с
 * исправленными значениями. Возвращает true, если что-то реально изменилось и
 * документ пересоздан.
 */
export async function applyCorrection(
  last: PendingDocgen,
  userText: string,
  ctx: DocgenCtx
): Promise<boolean> {
  const template = await templateByKey(last.template_key);
  if (!template) return false;

  const prior: FieldValues = { ...(last.fields || {}) };
  const label = labeller(template);
  const knownDesc =
    Object.entries(prior)
      .filter(([, v]) => !isBlank(v))
      .map(([k, v]) => `${label(k)}=${v}`)
      .join(', ') || '—';
  const context =
    `Ранее оформлен документ со значениями: ${knownDesc}.\n` +
    'Пользователь просит ИСПРАВИТЬ одно или несколько полей. Верните ТОЛЬКО те ' +
    'поля, для которых в сообщении указано новое значение (остальные — null).';

  let newFields: FieldValues = {};
  try {
    newFields = validateFields((await extractFields(userText, template, context)) || {}, template);
  } catch {
    newFields = {};
  }

  const merged: FieldValues = { ...prior };
  let changed = false;
  for (const [k, v] of Object.entries(newFields)) {
    if (isBlank(v)) continue;
    // `str(merged.get(k) or "")` из Python: null/0/"" одинаково дают пустую строку
    if (String(v).trim() !== String(merged[k] || '').trim()) {
      merged[k] = v;
      changed = true;
    }
  }
  if (!changed) return false;

  await docgenRenderAndReply(template, fillDefaults(merged, template), ctx);
  return true;
}
