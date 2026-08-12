import 'server-only';
import { prisma } from '@/lib/db';
import { generateJson } from '@/lib/ml/llm-json';
import { SYSTEM_PROMPT_EXTRACT, SYSTEM_PROMPT_INTENT } from '@/lib/ml/prompts';
import { ru } from './common';

/**
 * Распознавание HR-команд: «нанять Иванова», «оформить отпуск Петровой».
 * Порт backend/services/documents/intent.py.
 *
 * Тексты промптов и формулировки регэкспов менять НЕЛЬЗЯ: от них зависит, какой
 * шаблон выберет модель и что она положит в поля — расхождение с Python дало бы
 * другой документ на тот же запрос.
 */

// ---------------------------------------------------------------------------
// Шаблон и его схема полей
// ---------------------------------------------------------------------------

/** Поле шаблона из doc_templates.fields_schema (json). */
export interface TemplateField {
  name: string;
  label?: string | null;
  type?: string | null;
  required?: boolean | null;
}

/** Минимум полей DocTemplate, нужный докгену (реальная строка Prisma шире). */
export interface DocTemplateLike {
  id: number;
  key: string;
  title: string;
  description?: string | null;
  file_path: string;
  fields_schema: unknown;
  extraction_prompt?: string | null;
}

/**
 * `template.fields_schema or []` в типизированном виде. Колонка — свободный
 * json, поэтому мусорные элементы (не-объекты, объекты без name) отбрасываем:
 * в Python они бы упали на `f["name"]`.
 */
export function templateFields(tpl: { fields_schema: unknown }): TemplateField[] {
  const raw = tpl.fields_schema;
  if (!Array.isArray(raw)) return [];
  const out: TemplateField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name) continue;
    out.push({
      name: rec.name,
      label: typeof rec.label === 'string' ? rec.label : null,
      type: typeof rec.type === 'string' ? rec.type : null,
      required: typeof rec.required === 'boolean' ? rec.required : null,
    });
  }
  return out;
}

/** Значения полей: `null` = «неизвестно», как в Python. */
export type FieldValues = Record<string, unknown>;

/** `v in (None, "")` из Python: 0 и false считаются заполненными. */
export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/**
 * `json.dumps(obj, ensure_ascii=False)`: разделители по умолчанию — «, » и
 * «: ». JSON.stringify пишет без пробелов, а текст промпта должен совпадать.
 */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  const parts = Object.entries(value as Record<string, unknown>).map(
    ([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`
  );
  return `{${parts.join(', ')}}`;
}

// ---------------------------------------------------------------------------
// detect_template
// ---------------------------------------------------------------------------

/**
 * LLM-классификация: соответствует ли запрос намерению создать какой-либо
 * зарегистрированный шаблон. Возвращает шаблон или null.
 */
export async function detectTemplate(query: string): Promise<DocTemplateLike | null> {
  const templates = await prisma.doc_templates.findMany({
    where: { is_enabled: true },
    // В Python порядок не задан; фиксируем его, чтобы список в промпте был
    // стабильным от запроса к запросу (иначе модель «плавает»).
    orderBy: { id: 'asc' },
  });
  if (!templates.length) return null;

  const items = templates
    .map((t) => `- key="${t.key}": ${t.title}` + (t.description ? ` — ${t.description}` : ''))
    .join('\n');

  const user =
    `Доступные шаблоны HR-документов:\n${items}\n\n` +
    `Запрос пользователя:\n${(query || '').trim()}\n\n` +
    'Верни JSON по схеме: ' +
    '{"action":"generate|ask","template_key":"<один из ключей выше или null>"}.';

  const data = await generateJson(SYSTEM_PROMPT_INTENT, user, 'action, template_key');
  if (!data) return null;
  if (data.action !== 'generate') return null;
  const key = (typeof data.template_key === 'string' ? data.template_key : '').trim();
  if (!key) return null;
  return templates.find((t) => t.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// extract_fields
// ---------------------------------------------------------------------------

/**
 * Просит LLM извлечь значения полей шаблона из произвольного русского текста.
 *
 * `context` — необязательный текст предыдущих реплик диалога. Нужен, чтобы
 * доизвлечь поля, если пользователь досказывает недостающие сведения отдельным
 * сообщением («оклад 50000») в ответ на просьбу уточнить.
 */
export async function extractFields(
  query: string,
  template: DocTemplateLike,
  context: string | null = null
): Promise<FieldValues> {
  const schema = templateFields(template);
  if (!schema.length) return {};

  // Подсказываем модели тип поля — чтобы в числовые поля не попадал текст.
  const desc = (f: TemplateField): string => {
    const label = f.label || f.name;
    const hint = isNumericField(f) ? ' (число)' : '';
    return `- ${f.name}: ${label}${hint}`;
  };

  const fieldsDesc = schema.map(desc).join('\n');
  const contextBlock =
    context && context.trim()
      ? `Контекст предыдущих сообщений (используйте, если в запросе не хватает данных):\n${context.trim()}\n\n`
      : '';
  const user =
    'Извлеките значения полей из запроса HR-специалиста.\n' +
    `Поля:\n${fieldsDesc}\n\n` +
    `${contextBlock}` +
    `Запрос: ${(query || '').trim()}\n\n` +
    'Верните строго JSON. Если значение неизвестно — null. ' +
    'В числовые поля (помечены «(число)») кладите ТОЛЬКО число без слов и единиц; ' +
    'если в запросе для такого поля названо не число — верните для него null. ' +
    'Не добавляйте полей, которых нет в списке.';

  const schemaHint = pyJson(
    Object.fromEntries(schema.map((f) => [f.name, f.type || 'string']))
  );
  const data = await generateJson(SYSTEM_PROMPT_EXTRACT, user, schemaHint);
  if (!data) return {};

  // Оставляем только известные поля
  const known = new Set(schema.map((f) => f.name));
  const out: FieldValues = {};
  for (const [k, v] of Object.entries(data)) if (known.has(k)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Умолчания и заголовок
// ---------------------------------------------------------------------------

const TODAY_LIKE = new Set([
  'date', 'date_today', 'today',
  'date_start', 'start_date', 'дата', 'дата_начала',
]);

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** Подставляет умолчания (например, сегодняшнюю дату для пустых date-полей). */
export function fillDefaults(fields: FieldValues, template: DocTemplateLike): FieldValues {
  const d = new Date();
  const todayStr = `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`;
  const out: FieldValues = { ...(fields || {}) };
  for (const f of templateFields(template)) {
    if (isBlank(out[f.name]) && TODAY_LIKE.has(f.name.toLowerCase())) out[f.name] = todayStr;
  }
  return out;
}

/** Удобное имя для отображения в чате и MyDocuments. */
export function summarizeForTitle(template: DocTemplateLike, fields: FieldValues): string {
  const pick = (a: string, b: string) => fields[a] ?? fields[b];
  const bits = [
    pick('surname', 'фамилия'),
    pick('name', 'имя'),
    pick('patronymic', 'отчество'),
  ].filter((p) => p);
  if (bits.length) return `${template.title} — ${bits.join(' ')}`;
  return template.title;
}

// ---------------------------------------------------------------------------
// Пред-фильтр «похоже на запрос документа»
// ---------------------------------------------------------------------------

const TRIGGER_WORDS = [
  // Приём на работу: «нанять/найми/наняла/нанимаем», «приём/принять/прими»
  'наним', 'нанят', 'нанял', 'нанима', 'найм', 'найми',
  'приня', 'прими', 'прин[еия]', 'приём', 'прием',
  // Увольнение
  'уволь', 'уволи', 'уволен', 'увольн',
  // Отпуск, переводы
  'отпуск', 'перевод', 'перевест',
  // Прямые команды на генерацию документов
  'оформ', 'состав', 'созда', 'сгенер', 'подготов', 'выдай',
  'сделай.*(приказ|документ|заявлен)', 'подпиши',
  // Названия документов
  'приказ', 'заявлен', 'служебн', 'справк',
];
const TRIGGER_RE = new RegExp(TRIGGER_WORDS.join('|'), 'i');

/** Лёгкий пред-фильтр, чтобы не дёргать LLM на каждый «привет». */
export function looksLikeDocRequest(query: string): boolean {
  if (!query || query.length < 8) return false;
  return TRIGGER_RE.test(query);
}

// ---------------------------------------------------------------------------
// Валидация и нормализация полей перед рендером
// ---------------------------------------------------------------------------
// Числовые/денежные поля: чтобы в оклад не попали «пельмени». Определяем по типу
// поля в схеме ИЛИ по смыслу имени/подписи.

const NUMERIC_TYPES = new Set(['number', 'int', 'integer', 'float', 'amount', 'money', 'decimal']);
const MONEY_NUM_NAME_RE = ru(
  'оклад|зарплат|\\bзп\\b|ставк|сумм|размер|оплат|надбавк|преми|тариф|' +
    'количеств|кол-?во|\\bчисло\\b|salary|amount|count|price|\\bsum\\b|rate|salary',
  'i'
);
// Первый числовой фрагмент: «100 000 пельменей» → «100 000».
// В классе — обычный и неразрывный пробел (как в Python-исходнике).
const NUM_TOKEN_RE = /-?\d[\d  .,]*/;

function isNumericField(field: TemplateField): boolean {
  if (NUMERIC_TYPES.has(String(field.type ?? '').toLowerCase())) return true;
  return MONEY_NUM_NAME_RE.test(`${field.name ?? ''} ${field.label ?? ''}`);
}

/**
 * «100000 пельменей» → «100000»; «пельмени» → null; 50000 → «50000».
 * Возвращает очищенное число-строку или null, если числа в значении нет.
 */
function coerceNumeric(value: unknown): string | null {
  const s = pyStr(value).trim();
  const m = NUM_TOKEN_RE.exec(s);
  if (!m) return null;
  // .strip(".,-") — снимаем эти символы с обоих концов
  const token = m[0].replace(/[^\d.,-]/g, '').replace(/^[.,-]+|[.,-]+$/g, '');
  return token || null;
}

/** `str(v)` из Python: bool печатается как True/False. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

/**
 * Приводит числовые поля к числу и отбрасывает мусор (текст в поле оклада).
 * Некорректное значение обнуляется (→ null) — дальше оно считается «недостающим».
 */
export function validateFields(fields: FieldValues, template: DocTemplateLike): FieldValues {
  const schema = new Map(templateFields(template).map((f) => [f.name, f]));
  const out: FieldValues = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (isBlank(v)) {
      out[k] = v;
      continue;
    }
    const f = schema.get(k);
    if (f && isNumericField(f)) out[k] = coerceNumeric(v);
    else out[k] = v;
  }
  return out;
}

/**
 * Список ИМЁН обязательных полей, которых не хватает (перевод подписи — на
 * этапе показа, см. ruFieldLabel). По умолчанию поле обязательно (required
 * отсутствует → true); опциональные помечаются явно required=false.
 */
export function missingRequiredFields(fields: FieldValues, template: DocTemplateLike): string[] {
  const missing: string[] = [];
  for (const f of templateFields(template)) {
    if (f.required === false) continue;
    if (isBlank((fields || {})[f.name])) missing.push(f.name);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Русские подписи типовых HR-полей
// ---------------------------------------------------------------------------
// Шаблоны часто содержат латинские имена переменных ({{patronymic}}, {{position}}),
// и авто-подпись выходит английской. Для показа пользователю переводим по словарю.

export const RU_FIELD_LABELS: Record<string, string> = {
  surname: 'Фамилия', lastname: 'Фамилия', last_name: 'Фамилия',
  name: 'Имя', firstname: 'Имя', first_name: 'Имя',
  patronymic: 'Отчество', middlename: 'Отчество', middle_name: 'Отчество',
  fio: 'ФИО', full_name: 'ФИО', fullname: 'ФИО',
  position: 'Должность', post: 'Должность', job: 'Должность', job_title: 'Должность',
  department: 'Подразделение', subdivision: 'Подразделение', unit: 'Подразделение',
  division: 'Подразделение',
  salary: 'Оклад', oklad: 'Оклад', wage: 'Оклад', pay: 'Оклад',
  rate: 'Ставка', tariff: 'Ставка',
  date: 'Дата', date_today: 'Дата', today: 'Дата',
  date_start: 'Дата начала', start_date: 'Дата начала', date_from: 'Дата начала',
  date_end: 'Дата окончания', end_date: 'Дата окончания', date_to: 'Дата окончания',
  birth_date: 'Дата рождения', birthdate: 'Дата рождения', dob: 'Дата рождения',
  order_number: 'Номер приказа', order_no: 'Номер приказа',
  number: 'Номер', num: 'Номер', no: 'Номер',
  employee: 'Сотрудник', worker: 'Сотрудник', employer: 'Работодатель',
  reason: 'Основание', basis: 'Основание', ground: 'Основание',
  organization: 'Организация', company: 'Организация', org: 'Организация',
  contract_number: 'Номер договора', contract_no: 'Номер договора',
  contract_date: 'Дата договора',
  vacation_days: 'Дней отпуска', days: 'Количество дней', duration: 'Длительность',
  phone: 'Телефон', email: 'Эл. почта', address: 'Адрес',
  passport: 'Паспорт', snils: 'СНИЛС', inn: 'ИНН',
};

const HAS_CYRILLIC_RE = /[А-Яа-яЁё]/;

/**
 * Русская подпись поля по его имени. Если имя незнакомо — возвращаем
 * хранимую подпись (если она уже кириллицей), иначе имя как есть.
 */
export function ruFieldLabel(name: string, fallback: string | null = null): string {
  const key = (name || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(RU_FIELD_LABELS, key)) return RU_FIELD_LABELS[key];
  if (fallback && HAS_CYRILLIC_RE.test(fallback)) return fallback;
  return fallback || name || '';
}

// ---------------------------------------------------------------------------
// Явные намерения пользователя в диалоге генерации
// ---------------------------------------------------------------------------

// «Имя неправильно — должно быть …», «исправь отчество на …», «не Иванов, а Петров» —
// намерение ИСПРАВИТЬ уже заполненное поле (а не просто дозаполнить пустое).
const CORRECTION_RE = ru(
  'неправильн\\w*|не\\s+так\\b|неверн\\w*|не\\s+верн\\w*|ошибк\\w*|ошиба\\w*|' +
    'исправ\\w*|поменя\\w*|замен\\w*|должн[оаы]\\s+быть|на\\s+самом\\s+деле|' +
    '\\bа\\s+не\\b|вместо\\b|перепута\\w*|опечат\\w*|некорректн\\w*',
  'i'
);

export function wantsCorrection(query: string): boolean {
  return CORRECTION_RE.test(query || '');
}

// «Сгенерируй как есть / без обязательных полей / оставь пустым» — разрешение
// создать документ, не заполняя недостающие поля (пустые останутся пустыми).
const FORCE_GENERATE_RE = ru(
  'как\\s+есть|без\\s+(обязательн|остальн|недоста|заполнен)|' +
    'остав(ь|ить)\\s+пуст|пуст(ым|ыми|ое)|не\\s+заполня|не\\s+спрашива|' +
    'всё\\s+равно|все\\s+равно|и\\s+так\\s+сойд[её]т|прост[оă]\\s+сгенерируй|' +
    'сгенерируй\\s+(так|всё|все|документ)|не\\s+важно|неважно|пропусти',
  'i'
);
// «Отмена / забудь / не надо» — отказ от начатой генерации документа.
const CANCEL_RE = ru(
  '\\bотмен\\w*|\\bзабуд\\w*|\\bне\\s+надо\\b|\\bне\\s+нужно\\b|\\bотбой\\b|' +
    '\\bстоп\\b|\\bпередума\\w*|\\bотстав\\w*|\\bне\\s+хочу\\b',
  'i'
);

export function wantsForceGenerate(query: string): boolean {
  return FORCE_GENERATE_RE.test(query || '');
}

export function wantsCancel(query: string): boolean {
  return CANCEL_RE.test(query || '');
}

/**
 * null → пустая строка: чтобы в документе не печаталось буквальное «None»
 * для необязательных незаполненных полей.
 */
export function normalizeForRender(fields: FieldValues): FieldValues {
  const out: FieldValues = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = v === null || v === undefined ? '' : v;
  return out;
}
