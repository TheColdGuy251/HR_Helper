import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { finishTool, persistAndFinish, type StreamState } from '@/lib/chat';
import { baseName, fromDocsPath, stemOf, suffixOf, toDocsPath } from '@/lib/news';
import { isNativelyParsable, parseFile } from '@/lib/parsers';
import type { AttachedDoc } from '@/lib/ml/pipeline';
import {
  activeSheet,
  errText,
  firstSheet,
  readWorkbook,
  ru,
  saveGenerated,
  sheetRows,
  sheetTextRows,
  withTempFile,
} from './common';
import { extractProcessGraph, renderProcessSvg } from './processes';
import { readZipEntries } from './zip';
// Регэкспы-триггеры Б1/Б2/Б6 проверяет вызывающий код (lib/chat-generate.ts) —
// как и в Python, где они импортируются прямо в _run_generation.
import { createCharacteristic, parsePetition } from './characteristic';
import { createDpoReport } from './dpo-report';
import { createVacancy, extractDutiesSection } from './vacancy';
import { createInventory, INVENTORY_REQUEST_RE } from './dismissed-inventory';
import { CERTIFICATE_EMP_REQUEST_RE, createCertificate } from './employee-certificate';
import { OT_DEDUP_REQUEST_RE, runDedup } from './ot-dedup';
import { createAnnouncement, parseForm2Rows, PPS_REQUEST_RE, type Form2 } from './pps-announcement';

/**
 * Инструменты главной страницы, вызванные ЧАТ-КОМАНДОЙ с вложением.
 * Порт _handle_tool_request / _handle_dpo_report / _handle_characteristic /
 * _handle_vacancy и веток _tool_* из backend/routes/chat.py.
 *
 * ОТЛИЧИЕ ОТ PYTHON ПО ФОРМЕ, НЕ ПО СМЫСЛУ: питоновские create_* принимают путь
 * к файлу и сами его читают, а портированные lib/docs/* — уже разобранные
 * строки/текст (так же, как их зовут HTTP-эндпоинты в app/api/documents/**).
 * Поэтому чтение и разбор вложения делается здесь, а не внутри генератора.
 */

export interface ToolCtx {
  assistantMessageId: number;
  userId: number;
  state: StreamState;
  setStatus: (stage: string) => void;
}

/** Первое вложение с сохранённым оригиналом нужного формата. */
function attachBySuffix(attached: AttachedDoc[], suffixes: Set<string>): AttachedDoc | null {
  for (const a of attached) {
    const name = a.filename || a.stored_path || '';
    if (a.stored_path && suffixes.has(path.extname(name).toLowerCase())) return a;
  }
  return null;
}

const XL = new Set(['.xls', '.xlsx', '.xlsm']);

/**
 * `try/except` в виде значения: сужение типов после try/catch в TS ненадёжно,
 * а текст ошибки нужен для ответа пользователю (как `except Exception as e`).
 */
async function attempt<T>(
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Б2: отчёт по ДПО из xlsx-выгрузки «ПК за год»
// ---------------------------------------------------------------------------

/**
 * Пользователь прикрепил xlsx-выгрузку «ПК за год» и просит отчёт по ДПО.
 * Все числа считаются детерминированно из таблицы (без LLM).
 */
export async function handleDpoReport(
  attached: AttachedDoc[],
  ctx: ToolCtx
): Promise<boolean> {
  const src = attachBySuffix(attached, new Set(['.xlsx', '.xlsm']));
  if (!src) {
    // Вложение не табличное — подсказываем, но не гоним запрос в RAG.
    ctx.setStatus('generate');
    ctx.state.append(
      'Для отчёта по ДПО прикрепите **xlsx-выгрузку** из 1С:ЗиК ' +
        '(Обучение → отчёт «ПК за период»). Прикреплённый файл не похож на таблицу — ' +
        'я работаю с исходными колонками, а не с текстом.'
    );
    ctx.state.event.set();
    await persistAndFinish(ctx.assistantMessageId, ctx.state);
    return true;
  }

  ctx.setStatus('render_doc');
  const built = await attempt(async () => {
    const data = await readFile(fromDocsPath(src.stored_path as string));
    // openpyxl берёт первый лист книги (wb.worksheets[0]), а не активный.
    const rows = sheetTextRows(firstSheet(readWorkbook(data)));
    return createDpoReport(ctx.userId, rows);
  });
  if (!built.ok) {
    ctx.state.append(
      `Не удалось сформировать отчёт по ДПО: ${errText(built.error)}. Проверьте, что это выгрузка ` +
        '«ПК за период» из 1С:ЗиК (шапка с колонками «Физическое лицо», ' +
        '«Категория должности», «Вид образования» и т.д.).'
    );
    ctx.state.event.set();
    await persistAndFinish(ctx.assistantMessageId, ctx.state);
    return true;
  }

  const { rec, text, stats } = built.value;
  ctx.setStatus('generate');
  ctx.state.append(
    `Отчёт по ДПО за ${stats.year} год готов: ${stats.total_people} работников, ` +
      `${stats.total_programs} программ, ${stats.long_events} мероприятий (от 16 ч).\n\n` +
      `${text}\n\nФайл доступен ниже для скачивания.`
  );
  ctx.state.event.set();
  await persistAndFinish(ctx.assistantMessageId, ctx.state, null, rec.id);
  return true;
}

// ---------------------------------------------------------------------------
// Б1: характеристика из ходатайства
// ---------------------------------------------------------------------------

/**
 * Пользователь прикрепил ходатайство о награждении и просит характеристику.
 * Возвращает true, если запрос обработан этой веткой (иначе — обычный поток:
 * вложение не похоже на ходатайство, пусть RAG/чат объяснит, что нужно).
 */
export async function handleCharacteristic(
  attached: AttachedDoc[],
  ctx: ToolCtx
): Promise<boolean> {
  const text = (attached[0]?.content || '').trim();
  if (!text) return false;

  ctx.setStatus('extract_fields');
  const fields = await parsePetition(text, ctx.userId).catch(() => null);
  if (!fields) return false; // parse_petition упал — отдаём сообщение обычному потоку
  // Вложение не похоже на ходатайство — не перехватываем запрос.
  if (!fields.fio && !fields.achievements) return false;

  ctx.setStatus('render_doc');
  // category=null — как в Python: категория выводится внутри, из должности.
  const built = await attempt(() => createCharacteristic(ctx.userId, fields, null));
  if (!built.ok) {
    ctx.state.append(
      'Не удалось сформировать характеристику по ходатайству: ' +
        `${errText(built.error)}. Попробуйте карточку «Создать характеристику» на главной странице — ` +
        'там поля можно поправить вручную.'
    );
    ctx.state.event.set();
    await persistAndFinish(ctx.assistantMessageId, ctx.state);
    return true;
  }

  ctx.setStatus('generate');
  const headBits = [fields.fio, fields.award].filter((b): b is string => Boolean(b));
  let head = 'Характеристика по ходатайству сформирована';
  if (headBits.length) head += ` (${headBits.join('; ')})`;
  ctx.state.append(`${head}.\n\n${built.value.text}\n\nФайл доступен ниже для скачивания.`);
  ctx.state.event.set();
  await persistAndFinish(ctx.assistantMessageId, ctx.state, null, built.value.rec.id);
  return true;
}

// ---------------------------------------------------------------------------
// Б6: вакансия из должностной инструкции
// ---------------------------------------------------------------------------

/**
 * Пользователь прикрепил должностную инструкцию и просит текст вакансии.
 * Раздел 2 «Должностные обязанности» переписывается LLM в форму для job-сайтов.
 */
export async function handleVacancy(attached: AttachedDoc[], ctx: ToolCtx): Promise<boolean> {
  const text = (attached[0]?.content || '').trim();
  if (!text) return false;
  // Вложение не похоже на должностную инструкцию — пусть обычный чат объяснит.
  if (!extractDutiesSection(text) && !text.toLowerCase().includes('должностн')) return false;

  ctx.setStatus('render_doc');
  const built = await attempt(() => createVacancy(ctx.userId, text));
  if (!built.ok) {
    ctx.state.append(
      `Не удалось сформировать текст вакансии: ${errText(built.error)}. Попробуйте карточку ` +
        '«Вакансия из инструкции» на главной странице.'
    );
    ctx.state.event.set();
    await persistAndFinish(ctx.assistantMessageId, ctx.state);
    return true;
  }

  ctx.setStatus('generate');
  const { rec, text: vacText, meta } = built.value;
  let head = 'Текст вакансии готов';
  if (meta.position) head += ` (${meta.position})`;
  ctx.state.append(
    `${head}.\n\n${vacText}\n\nЗарплату, график и контакты добавьте перед публикацией. ` +
      'Файл доступен ниже для скачивания.'
  );
  ctx.state.event.set();
  await persistAndFinish(ctx.assistantMessageId, ctx.state, null, rec.id);
  return true;
}

// ---------------------------------------------------------------------------
// Ветки Б3/Б4/Б5/Б7/А10 — диспетчер инструментов
// ---------------------------------------------------------------------------

// Триггер чат-команды: «приведи схему к единому виду», «перерисуй схему процесса».
// В Python константа лежит в services/processes.py; портированный
// lib/docs/processes.ts её не заводит (нужна только чату) — держим здесь.
const PROCESS_REQUEST_RE = ru(
  '(един\\w+\\s+(?:вид|стил)|схем\\w+\\s+процесс|перерису\\w+\\s+схем|стилизу\\w+\\s+схем)',
  'i'
);

type ToolHandler = (src: AttachedDoc, attached: AttachedDoc[], ctx: ToolCtx) => Promise<boolean>;

/**
 * Инструменты главной страницы по чат-команде с вложением: единая схема
 * процесса (А10), справка на работника (Б3), опись уволенных (Б4),
 * объявление конкурса ППС (Б5), дубликаты инструкций ОТ (Б7).
 * Возвращает true, если запрос обработан (в т.ч. подсказкой о нужном файле).
 */
export async function handleToolRequest(
  userTextRouted: string,
  attached: AttachedDoc[],
  ctx: ToolCtx
): Promise<boolean> {
  const tools: [RegExp, ToolHandler, Set<string>, string][] = [
    [OT_DEDUP_REQUEST_RE, toolOtDedup, new Set(['.zip']),
      'Прикрепите **ZIP-архив** с инструкциями (docx/doc/pdf/rtf/txt) — я сравню тексты и найду однотипные.'],
    [INVENTORY_REQUEST_RE, toolInventory, XL,
      'Для описи прикрепите **отчёт «Принято уволено»** из 1С:ЗиК (xls/xlsx).'],
    [CERTIFICATE_EMP_REQUEST_RE, toolCertificate, XL,
      'Для справки прикрепите **выгрузку «Справка на сотрудника»** из 1С:ЗиК (xls/xlsx).'],
    [PPS_REQUEST_RE, toolPps, XL,
      'Для объявления прикрепите **выгрузки «Форма 2»** из 1С:ЗиК (xls/xlsx, по одному файлу на должность).'],
    [PROCESS_REQUEST_RE, toolProcessSchema,
      new Set(['.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xlsm', '.xls']),
      'Для единой схемы прикрепите файл со схемой процесса из Word, Excel или PowerPoint.'],
  ];

  for (const [rx, handler, suffixes, hint] of tools) {
    if (!rx.test(userTextRouted)) continue;
    const src = attachBySuffix(attached, suffixes);
    if (!src) {
      ctx.setStatus('generate');
      return finishTool(ctx.assistantMessageId, ctx.state, hint);
    }
    ctx.setStatus('render_doc');
    try {
      return await handler(src, attached, ctx);
    } catch (e) {
      return finishTool(
        ctx.assistantMessageId,
        ctx.state,
        `Не удалось выполнить операцию: ${errText(e)}. Попробуйте одноимённую карточку на главной странице.`
      );
    }
  }
  return false;
}

// ── Б3: справка на работника ───────────────────────────────────────────────

async function toolCertificate(src: AttachedDoc, _attached: AttachedDoc[], ctx: ToolCtx) {
  const data = await readFile(fromDocsPath(src.stored_path as string));
  const { rec, fields } = await createCertificate(ctx.userId, sheetRows(activeSheet(readWorkbook(data))));

  const pk = fields['Повышение квалификации'];
  const work = fields['Работа по окончании ВУЗа'];
  const bits: string[] = [];
  if (Array.isArray(pk)) bits.push(`повышение квалификации — ${pk.length} записей за последние 3 года`);
  if (Array.isArray(work)) bits.push(`работа по должностям — ${work.length} строк без дублей приказов`);
  return finishTool(
    ctx.assistantMessageId,
    ctx.state,
    `Справка преобразована в читабельный вид (${bits.join('; ') || 'готово'}). ` +
      'Файл доступен ниже для скачивания.',
    rec.id
  );
}

// ── Б4: опись личных дел уволенных ─────────────────────────────────────────

async function toolInventory(src: AttachedDoc, _attached: AttachedDoc[], ctx: ToolCtx) {
  const data = await readFile(fromDocsPath(src.stored_path as string));
  // all_categories=False — как значение по умолчанию в create_inventory.
  const { rec, result } = await createInventory(
    ctx.userId,
    sheetRows(activeSheet(readWorkbook(data))),
    false
  );
  return finishTool(
    ctx.assistantMessageId,
    ctx.state,
    `Опись сформирована: в неё попали ${result.items.length} из ${result.fired_total} ` +
      `уволенных в ${result.year} году (категории АУП/АХП/УВП, повторно принятые ` +
      `исключены: ${result.skipped_rehired}). Даты увольнения — «дата записи» минус ` +
      'один день. Файл xlsx доступен ниже.',
    rec.id
  );
}

// ── Б5: объявление о выборах и конкурсе ППС ────────────────────────────────

async function toolPps(_src: AttachedDoc, attached: AttachedDoc[], ctx: ToolCtx) {
  const form2List: Form2[] = [];
  for (const a of attached) {
    if (!a.stored_path) continue;
    const name = a.filename || a.stored_path;
    if (!XL.has(path.extname(name).toLowerCase())) continue;
    const data = await readFile(fromDocsPath(a.stored_path));
    form2List.push(parseForm2Rows(sheetRows(activeSheet(readWorkbook(data))), baseName(name)));
  }
  const { rec, data } = await createAnnouncement(ctx.userId, form2List);
  return finishTool(
    ctx.assistantMessageId,
    ctx.state,
    `Объявление о выборах и конкурсе ППС от ${data.date} готово: ` +
      `${data.positions} должностей, ${data.departments} кафедр, ` +
      `${data.people} работников в выгрузках. Требования в скобках — черновик из ` +
      'данных переизбираемых, отредактируйте перед публикацией. Файл доступен ниже.',
    rec.id
  );
}

// ── Б7: дубликаты инструкций по охране труда ───────────────────────────────

const OT_ALLOWED = new Set(['.docx', '.doc', '.pdf', '.rtf', '.txt', '.odt']);
const OT_MAX_FILES = 500;

async function toolOtDedup(src: AttachedDoc, _attached: AttachedDoc[], ctx: ToolCtx) {
  // Порт run_dedup_zip: распаковка → парсинг → сравнение. Разбор ZIP живёт
  // здесь, потому что TS-порт runDedup принимает уже готовые тексты.
  const zipData = await readFile(fromDocsPath(src.stored_path as string));
  const picked: { name: string; suffix: string; read: () => Buffer }[] = [];
  for (const entry of readZipEntries(zipData)) {
    if (entry.dir || picked.length >= OT_MAX_FILES) continue;
    const fname = baseName(entry.name);
    const suffix = suffixOf(fname).toLowerCase();
    if (!fname || !OT_ALLOWED.has(suffix)) continue;
    picked.push({ name: fname, suffix, read: entry.read });
  }

  const docs: [string, string][] = [];
  const errors: string[] = [];
  for (const item of picked) {
    if (!isNativelyParsable(item.suffix)) {
      errors.push(item.name); // формат вне возможностей парсеров Next
      continue;
    }
    try {
      const parsed = await withTempFile(item.suffix, item.read(), (tmp) => parseFile(tmp));
      if ((parsed.text || '').trim()) docs.push([item.name, parsed.text]);
      else errors.push(item.name);
    } catch {
      errors.push(item.name); // [OT-DEDUP] файл не распарсился
    }
  }

  const { rec, result } = await runDedup(ctx.userId, docs, errors);
  const top = result.pairs.slice(0, 5);
  const lines = top.map((p) => `- ${p.a} ↔ ${p.b} — ${p.percent}%`).join('\n');
  return finishTool(
    ctx.assistantMessageId,
    ctx.state,
    `Сравнил ${result.files} инструкций: пар с совпадением ≥80% — ` +
      `${result.duplicates}, групп однотипных — ${result.groups.length}.` +
      (lines ? `\n\nСамые похожие:\n${lines}` : '') +
      '\n\nПолный xlsx-отчёт доступен ниже.',
    rec.id
  );
}

// ── А10: единая схема процесса ─────────────────────────────────────────────

/** `datetime.utcnow().strftime('%Y%m%d_%H%M%S')` — имя SVG считается по UTC. */
function utcTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

async function toolProcessSchema(src: AttachedDoc, _attached: AttachedDoc[], ctx: ToolCtx) {
  const graph = await extractProcessGraph(fromDocsPath(src.stored_path as string));
  if (graph === null) {
    return finishTool(
      ctx.assistantMessageId,
      ctx.state,
      'Не удалось распознать схему: в файле нет блоков со стрелками. Если схема — ' +
        'картинка или скан, векторно преобразовать её нельзя.'
    );
  }
  if (!graph.title) {
    // «!процесс вакансии ИИ.docx» → «Процесс вакансии»
    const stem = stemOf(baseName(src.filename || 'схема'))
      .replace(/^[!_ ]+/, '')
      .replace(/\s*ИИ\s*$/, '')
      .trim();
    const chars = Array.from(stem);
    graph.title = chars.length ? chars[0].toUpperCase() + chars.slice(1).join('') : null;
  }

  const svg = renderProcessSvg(graph);
  const filePath = await saveGenerated(`schema_${utcTimestamp()}.svg`, Buffer.from(svg, 'utf-8'));
  const rec = await prisma.my_documents.create({
    data: {
      user_id: ctx.userId,
      title: graph.title ? `Единая схема: ${graph.title}` : 'Единая схема процесса',
      template_key: 'process_schema',
      file_path: toDocsPath(filePath),
      progress: 100,
      status: 'ready',
      fields: { nodes: graph.nodes.length, edges: graph.edges.length } as Prisma.InputJsonValue,
      is_pii: false, // значение по умолчанию модели MyDocuments
    },
  });

  return finishTool(
    ctx.assistantMessageId,
    ctx.state,
    `Схема перерисована в едином стиле ТИУ: ${graph.nodes.length} блоков, ` +
      `${graph.edges.length} переходов, ${graph.nodes.filter((n) => n.role).length} ролей. ` +
      'SVG-файл доступен ниже (открывается в браузере, вставляется в Word).',
    rec.id
  );
}
