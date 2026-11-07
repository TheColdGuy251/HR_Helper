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

/** Диалоговая генерация документов по шаблону внутри чата. */

// ---------------------------------------------------------------------------
// Состояние добора полей (память процесса + снимок в PostgreSQL)
// ---------------------------------------------------------------------------
// Когда не хватает обязательных полей, запоминаем шаблон + уже собранные
// значения по id диалога; следующее сообщение пользователя досказывает
// недостающее.
//
// Рабочая копия - в памяти (globalThis, переживает hot-reload), но каждая
// мутация асинхронно сбрасывает снимок в app_state (lib/state.ts): после
// рестарта сервера loadDocgenState() поднимает его обратно, и диалог
// "уточни должность и оклад" продолжает работать. Ограничение "несколько
// инстансов Node не делят память" остаётся: снимок читается один раз на
// старте, а не на каждый запрос.

interface PendingDocgen {
  template_key: string;
  fields: FieldValues;
  created_at: number;
}

const g = globalThis as unknown as {
  __hrPendingDocgen?: Map<string, PendingDocgen>;
  __hrLastDocgen?: Map<string, PendingDocgen>;
  __hrDocgenLoaded?: Promise<void>;
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

const STATE_KEY = 'docgen';

type Snapshot = Record<'pending' | 'last', [string, PendingDocgen][]>;

/** Сбрасывает снимок обоих словарей в БД. Ошибки не мешают диалогу. */
function persistDocgen(): void {
  const fresh = (map: Map<string, PendingDocgen>) =>
    [...map.entries()].filter(([, p]) => Date.now() - p.created_at <= PENDING_TTL_MS);
  const snapshot: Snapshot = { pending: fresh(pendingMap()), last: fresh(lastMap()) };
  void import('@/lib/state')
    .then(({ stateSet }) => stateSet(STATE_KEY, snapshot))
    .catch(() => undefined);
}

/**
 * Поднимает состояние добора из БД после рестарта сервера. Вызывается в начале
 * runGeneration (lib/chat-generate.ts); повторные вызовы бесплатны.
 */
export function loadDocgenState(): Promise<void> {
  if (!g.__hrDocgenLoaded) {
    g.__hrDocgenLoaded = (async () => {
      // globalThis уже наполнен (hot-reload, а не рестарт) - БД не трогаем.
      if (g.__hrPendingDocgen?.size || g.__hrLastDocgen?.size) return;
      const { stateGet } = await import('@/lib/state');
      const snapshot = await stateGet<Snapshot>(STATE_KEY);
      if (!snapshot) return;
      for (const [sid, p] of snapshot.pending || []) pendingMap().set(sid, p);
      for (const [sid, p] of snapshot.last || []) lastMap().set(sid, p);
    })().catch(() => undefined);
  }
  return g.__hrDocgenLoaded;
}

function getFresh(map: Map<string, PendingDocgen>, dialogueId: string): PendingDocgen | null {
  const p = map.get(dialogueId);
  if (!p) return null;
  if (Date.now() - p.created_at > PENDING_TTL_MS) {
    map.delete(dialogueId);
    return null;
  }
  return p;
}

export function setPending(dialogueId: string, templateKey: string, fields: FieldValues): void {
  pendingMap().set(dialogueId, {
    template_key: templateKey,
    fields: { ...(fields || {}) },
    created_at: Date.now(),
  });
  persistDocgen();
}

export function getPending(dialogueId: string): PendingDocgen | null {
  return getFresh(pendingMap(), dialogueId);
}

export function clearPending(dialogueId: string): void {
  pendingMap().delete(dialogueId);
  persistDocgen();
}

// Последний успешно сгенерированный документ в диалоге - чтобы поддержать
// исправление полей после генерации ("имя неправильно - должно быть ...").
// Извлечение дергаем только на сообщениях-исправлениях, поэтому лишних вызовов
// LLM нет.
export function setLastDocgen(dialogueId: string, templateKey: string, fields: FieldValues): void {
  lastMap().set(dialogueId, {
    template_key: templateKey,
    fields: { ...(fields || {}) },
    created_at: Date.now(),
  });
  persistDocgen();
}

export function getLastDocgen(dialogueId: string): PendingDocgen | null {
  return getFresh(lastMap(), dialogueId);
}

// ---------------------------------------------------------------------------
// Общие помощники
// ---------------------------------------------------------------------------

/** Подписи полей шаблона: имя -> русская подпись для показа пользователю. */
function labeller(template: DocTemplateLike): (name: string) => string {
  const schema = new Map(templateFields(template).map((f) => [f.name, f]));
  return (n: string) => ruFieldLabel(n, schema.get(n)?.label ?? null);
}

async function templateByKey(key: string | undefined): Promise<DocTemplateLike | null> {
  if (!key) return null;
  return prisma.doc_templates.findFirst({ where: { key } });
}

export interface DocgenCtx {
  dialogueId: string;
  assistantMessageId: string;
  userId: string;
  state: StreamState;
  setStatus: (stage: string) => void;
}

// ---------------------------------------------------------------------------
// Запрос недостающих полей
// ---------------------------------------------------------------------------

/**
 * Просит у пользователя недостающие обязательные поля и запоминает контекст
 * (шаблон + уже собранные значения) для диалогового добора.
 * `missing` - список имён полей; подписи для показа переводим на русский.
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

  setPending(ctx.dialogueId, template.key, fields);
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
  let docId: string | null = null;
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
  // Запоминаем последний документ диалога - для исправления полей после генерации.
  setLastDocgen(ctx.dialogueId, template.key, fields);
}

// ---------------------------------------------------------------------------
// Первичная обработка запроса на документ
// ---------------------------------------------------------------------------

/**
 * "Оформи приказ", "нанять X" и т.п. Извлекает поля; если не хватает
 * обязательных и пользователь не просил "как есть" - запрашивает недостающее
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
  let extractedCount = 0;
  try {
    if (!Object.keys(fields).length) fields = (await extractFields(userText, template)) || {};
    // Сколько полей реально извлечено из текста пользователя - считаем до
    // fillDefaults: тот подставляет сегодняшнюю дату и маскирует пустоту.
    extractedCount = templateFields(template).filter((f) => !isBlank(fields[f.name])).length;
    fields = fillDefaults(fields, template);
    // Числовые поля приводим к числу и отбрасываем мусор ("пельмени" в оклад).
    fields = validateFields(fields, template);
  } catch {
    /* extract_fields failed - работаем с тем, что уже есть */
  }

  let missing = missingRequiredFields(fields, template);
  // Команда без единого извлечённого поля ("сделай заявление о выходе из
  // отпуска") у шаблона, где все поля необязательные: не рендерим пустографку
  // молча, а спрашиваем данные - как при недостающих обязательных. "Сгенерируй
  // как есть" (force) по-прежнему рендерит сразу.
  if (!missing.length && !force && !extractedCount) {
    const schema = templateFields(template);
    if (schema.length) missing = schema.slice(0, 6).map((f) => f.name);
  }
  if (missing.length && !force) {
    await docgenAskMissing(template, fields, missing, ctx);
    return;
  }

  clearPending(ctx.dialogueId);
  await docgenRenderAndReply(template, fields, ctx);
}

// ---------------------------------------------------------------------------
// Продолжение добора
// ---------------------------------------------------------------------------

/**
 * Пользователь досказывает поля для начатой генерации. Возвращает true, если
 * сообщение обработано как продолжение (запрос ещё полей / генерация / отмена);
 * false - если пользователь сменил тему (тогда pending снят и сообщение уходит
 * в обычный поток).
 */
export async function continueDocgen(
  pending: PendingDocgen,
  userText: string,
  ctx: DocgenCtx
): Promise<boolean> {
  const template = await templateByKey(pending.template_key);
  if (!template) {
    clearPending(ctx.dialogueId);
    return false;
  }

  // Явная отмена начатого оформления.
  if (wantsCancel(userText)) {
    clearPending(ctx.dialogueId);
    ctx.setStatus('generate');
    ctx.state.append(`Хорошо, отменил оформление «${template.title}».`);
    ctx.state.event.set();
    await persistAndFinish(ctx.assistantMessageId, ctx.state);
    return true;
  }

  const force = wantsForceGenerate(userText);
  const isCorrection = wantsCorrection(userText);

  const prior: FieldValues = { ...(pending.fields || {}) };
  // Контекст для извлечения: что уже есть и чего не хватает - чтобы одиночные
  // значения без подписи ("Александровна", "лаборант") сопоставились с нужными
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

  // Fallback: LLM не распознала значение (например, "HR-служба" как подразделение),
  // но не хватает ровно одного поля и пользователь прислал обычное значение (не
  // вопрос/команда) -> это и есть ответ на наш вопрос. Кладём текст прямо в поле.
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

  // Ни одного поля не заполнил/не исправил и не просит "как есть" -> он сменил
  // тему: снимаем pending и отдаём сообщение обычному потоку (RAG/чат).
  if (!gotNew && !force) {
    clearPending(ctx.dialogueId);
    return false;
  }

  const filled = fillDefaults(merged, template);
  const missing = missingRequiredFields(filled, template);
  if (missing.length && !force) {
    await docgenAskMissing(template, filled, missing, ctx);
    return true;
  }

  clearPending(ctx.dialogueId);
  await docgenRenderAndReply(template, filled, ctx);
  return true;
}

// ---------------------------------------------------------------------------
// Исправление уже созданного документа
// ---------------------------------------------------------------------------

/**
 * "Имя неправильно - должно быть ..." после генерации: перегенерирует документ с
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
    // null/0/"" одинаково дают пустую строку
    if (String(v).trim() !== String(merged[k] || '').trim()) {
      merged[k] = v;
      changed = true;
    }
  }
  if (!changed) return false;

  await docgenRenderAndReply(template, fillDefaults(merged, template), ctx);
  return true;
}
