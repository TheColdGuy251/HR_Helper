import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { isoUtc, prisma } from '@/lib/db';
import { badRequest, requireKbEditor, requireUser } from '@/lib/auth';
import { asList, internalError, pyInt, TEMPLATES_DIR } from '@/lib/kb';
import { baseName, stemOf, suffixOf } from '@/lib/news';
import { convertToModern } from '@/lib/parsers/office-convert';
import { allParagraphs, isElement, loadDocxBody, type XmlElement } from '../_docx';
// Схему полей бланка считает общий модуль (тот же, что зовёт генератор
// документов), чтобы алгоритм автозаполнения жил в одном месте.
import { analyzeBlank, type FieldSpec } from '@/lib/docs/autofill';
import { invalidateBlankCatalog } from '@/lib/ml/blank-forms';

// Список и загрузка шаблонов HR-документов.
// Порт GET/POST /api/kb/templates из backend/routes/kb.py (list_templates,
// upload_template).

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const items = await prisma.doc_templates.findMany({ orderBy: { created_at: 'desc' } });

  return NextResponse.json({
    success: true,
    items: items.map((t) => {
      const fields = asList(t.fields_schema);
      return {
        id: t.id,
        key: t.key,
        title: t.title,
        description: t.description,
        is_enabled: t.is_enabled,
        category_id: t.category_id,
        fields_count: fields.length,
        fields,
        created_at: isoUtc(t.created_at),
      };
    }),
  });
}

// ── Русские подписи типовых HR-полей (services/documents/intent.py) ────────
// Шаблоны часто содержат латинские имена переменных ({{patronymic}}, {{position}}),
// и авто-подпись выходит английской. Для показа пользователю переводим по словарю.

const RU_FIELD_LABELS: Record<string, string> = {
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
 * Русская подпись поля по его имени. Если имя незнакомо — возвращаем хранимую
 * подпись (если она уже кириллицей), иначе имя как есть. Порт ru_field_label.
 */
function ruFieldLabel(name: string, fallback: string): string {
  const key = (name || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(RU_FIELD_LABELS, key)) return RU_FIELD_LABELS[key];
  if (fallback && HAS_CYRILLIC_RE.test(fallback)) return fallback;
  return fallback || name || '';
}

/** str.capitalize(): первая буква заглавная, ОСТАЛЬНЫЕ строчные. */
function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

/** Порт _slugify: `\w` в Python знает юникод, поэтому кириллица остаётся. */
function slugify(s: string): string {
  const cleaned = (s || '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '_');
  return cleaned.replace(/^_+|_+$/g, '').toLowerCase().slice(0, 64) || 'template';
}

// ── Извлечение {{переменных}} (порт _extract_template_fields) ──────────────
// docxtpl собирает jinja-шаблон из всего document.xml и отдаёт
// meta.find_undeclared_variables(). Здесь тот же результат достигается разбором
// СКЛЕЕННОГО текста абзаца: Word рвёт «{{ имя }}» между соседними <w:t>
// (проверка орфографии, правки), поэтому искать по отдельным прогонам нельзя.
//
// ОТЛИЧИЯ ОТ docxtpl: тег, разорванный МЕЖДУ абзацами, не найдётся (в jinja он
// сработал бы); из {% … %} распознаются только for/if/elif/set — «умных»
// конструкций в HR-шаблонах не бывает, а полный разбор jinja здесь не нужен.

const JINJA_KEYWORDS = new Set([
  'if', 'elif', 'else', 'endif', 'for', 'endfor', 'in', 'not', 'and', 'or', 'is',
  'none', 'true', 'false', 'set', 'endset', 'block', 'endblock', 'macro', 'endmacro',
  'call', 'endcall', 'filter', 'endfilter', 'with', 'endwith', 'without', 'context',
  'raw', 'endraw', 'include', 'import', 'from', 'as', 'do', 'break', 'continue',
  'loop', 'recursive', 'scoped', 'ignore', 'missing', 'autoescape', 'endautoescape',
  'trans', 'endtrans', 'pluralize', 'print', 'defined', 'undefined',
]);

const IDENT_RE = /[\p{L}_][\p{L}\p{N}_]*/gu;

/** Корневые имена выражения: `a.b` → a, `x|upper` → x, строки игнорируются. */
function collectNames(expr: string, declared: Set<string>, out: Set<string>): void {
  const src = expr.replace(/'[^']*'|"[^"]*"/g, ' ');
  IDENT_RE.lastIndex = 0;
  for (const m of src.matchAll(IDENT_RE)) {
    const name = m[0];
    // Атрибут (obj.attr) и имя фильтра/теста (x|upper, x is defined) — не переменные.
    if (/[.|]\s*$/.test(src.slice(0, m.index))) continue;
    if (JINJA_KEYWORDS.has(name.toLowerCase())) continue;
    if (declared.has(name)) continue;
    out.add(name);
  }
}

const OUTPUT_TAG_RE = /\{\{([\s\S]*?)\}\}/g;
const STMT_TAG_RE = /\{%([\s\S]*?)%\}/g;

/** Весь текст абзаца, включая вложенные элементы (гиперссылки, поля). */
function paragraphAllText(paragraph: XmlElement): string {
  let out = '';
  const walk = (el: XmlElement) => {
    for (const child of el.children) {
      if (!isElement(child)) continue;
      if (child.name === 'w:t') {
        out += child.children.filter((x) => !isElement(x)).join('');
      } else if (child.name === 'w:tab') out += '\t';
      else walk(child);
    }
  };
  walk(paragraph);
  return out;
}

/** Отсортированный список {{переменных}} шаблона (sorted(...) в Python). */
function extractTemplateFields(data: Buffer): string[] {
  const body = loadDocxBody(data);
  const declared = new Set<string>();
  const found = new Set<string>();

  for (const paragraph of allParagraphs(body)) {
    const text = paragraphAllText(paragraph);
    if (!text.includes('{')) continue;

    STMT_TAG_RE.lastIndex = 0;
    for (const m of text.matchAll(STMT_TAG_RE)) {
      // Префиксы docxtpl: {%p …%}, {%tr …%}, {%tc …%}, {%r …%}
      const stmt = m[1].replace(/^\s*(?:p|tr|tc|r)\b/, '').trim();
      const head = stmt.split(/\s+/)[0];
      if (head === 'for') {
        const loop = /^for\s+([\s\S]+?)\s+in\s+([\s\S]+)$/.exec(stmt);
        if (loop) {
          for (const t of loop[1].split(',')) declared.add(t.trim());
          collectNames(loop[2], declared, found);
        }
      } else if (head === 'if' || head === 'elif') {
        collectNames(stmt.slice(head.length), declared, found);
      } else if (head === 'set') {
        const assign = /^set\s+([\p{L}_][\p{L}\p{N}_]*)\s*=([\s\S]*)$/u.exec(stmt);
        if (assign) {
          declared.add(assign[1]);
          collectNames(assign[2], declared, found);
        }
      } else if (!JINJA_KEYWORDS.has(head.toLowerCase())) {
        collectNames(stmt, declared, found);
      }
    }

    OUTPUT_TAG_RE.lastIndex = 0;
    for (const m of text.matchAll(OUTPUT_TAG_RE)) collectNames(m[1], declared, found);
  }

  return [...found].filter((name) => !declared.has(name)).sort();
}

// ── Загрузка шаблона ───────────────────────────────────────────────────────

interface PydanticError {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: unknown;
}

function missing(loc: (string | number)[]): PydanticError {
  return { type: 'missing', loc, msg: 'Field required', input: null };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  // Тело читаем в буфер: .doc уходит в FastAPI тем же байт-в-байт запросом,
  // а второй раз прочитать поток нельзя.
  const raw = await request.arrayBuffer();
  let form: FormData;
  try {
    form = await new Response(raw, {
      headers: { 'content-type': request.headers.get('content-type') || '' },
    }).formData();
  } catch {
    return NextResponse.json(
      { detail: [missing(['body', 'file']), missing(['body', 'title'])] },
      { status: 422 }
    );
  }

  // Ошибки валидации FastAPI отдаёт списком, в порядке объявления параметров.
  const errors: PydanticError[] = [];
  const file = form.get('file');
  if (!(file instanceof File)) errors.push(missing(['body', 'file']));

  const titleValue = form.get('title');
  if (titleValue === null || titleValue instanceof File) errors.push(missing(['body', 'title']));

  const descriptionValue = form.get('description');
  const keyValue = form.get('key');

  const categoryValue = form.get('category_id');
  let categoryId: number | null = null;
  if (categoryValue !== null) {
    const parsed = typeof categoryValue === 'string' ? pyInt(categoryValue) : null;
    if (parsed === null) {
      errors.push({
        type: 'int_parsing',
        loc: ['body', 'category_id'],
        msg: 'Input should be a valid integer, unable to parse string as an integer',
        input: typeof categoryValue === 'string' ? categoryValue : null,
      });
    } else {
      categoryId = parsed;
    }
  }
  if (errors.length || !(file instanceof File)) {
    return NextResponse.json({ detail: errors }, { status: 422 });
  }

  const title = String(titleValue);
  const description = descriptionValue === null ? null : String(descriptionValue);
  const key = keyValue === null ? null : String(keyValue);

  const suffix = suffixOf(file.name || '').toLowerCase();
  if (suffix !== '.docx' && suffix !== '.doc' && suffix !== '.pdf') {
    return badRequest('Поддерживаются .docx, .doc и .pdf');
  }

  await mkdir(TEMPLATES_DIR, { recursive: true });
  const safeName = baseName(file.name || '') || 'template.docx';
  let target = path.join(TEMPLATES_DIR, safeName);
  // При коллизии добавляем суффикс
  let n = 1;
  while (await exists(target)) {
    target = path.join(TEMPLATES_DIR, `${stemOf(safeName)}_${n}${suffix}`);
    n += 1;
  }
  const data = Buffer.from(await file.arrayBuffer());
  await writeFile(target, data);

  let fieldsSchema: FieldSpec[];
  if (suffix === '.pdf') {
    // PDF-шаблон нельзя заполнять переменными — это справочная форма
    // (доступна для предпросмотра и скачивания). Полей нет.
    fieldsSchema = [];
  } else {
    let variables: string[];
    try {
      // .doc не является zip-контейнером: приводим его к .docx через
      // LibreOffice и разбираем уже современный формат. Сам файл шаблона
      // остаётся на диске в исходном виде — как и в Python.
      const docxData =
        suffix === '.doc' ? await readFile(await convertToModern(target)) : data;
      variables = extractTemplateFields(docxData);
    } catch (e) {
      await unlink(target).catch(() => undefined);
      const detail = String(e instanceof Error ? e.message : e);
      return badRequest(`Не удалось разобрать шаблон: ${detail}`);
    }

    if (variables.length) {
      // Обычный шаблон с {{переменными}}.
      fieldsSchema = variables.map((v) => ({
        name: v,
        label: ruFieldLabel(v, capitalize(v.replace(/_/g, ' '))),
        type: 'string',
        required: true,
      }));
    } else {
      // Бланк БЕЗ переменных → авто-определяем поля (autofill.analyze).
      try {
        fieldsSchema = analyzeBlank(data);
      } catch {
        // В Python эта ветка не защищена — исключение доходит до 500.
        return internalError();
      }
    }
  }

  let templateKey = key || slugify(title);
  // Уникальность ключа
  const clash = await prisma.doc_templates.findFirst({
    where: { key: templateKey },
    select: { id: true },
  });
  // n — счётчик коллизий ИМЕНИ ФАЙЛА (1, если файл не совпал): так же в Python.
  if (clash) templateKey = `${templateKey}_${n}`;

  // Если категория не указана — пробуем «Прочее».
  if (categoryId === null) {
    const other = await prisma.template_categories.findFirst({
      where: { slug: 'other' },
      select: { id: true },
    });
    categoryId = other ? other.id : null;
  }

  const tpl = await prisma.doc_templates.create({
    data: {
      key: templateKey,
      title,
      description,
      file_path: path.relative(TEMPLATES_DIR, target),
      fields_schema: fieldsSchema as unknown as Prisma.InputJsonValue,
      category_id: categoryId,
      // Значение по умолчанию из модели SQLAlchemy (в схеме Prisma его нет).
      is_enabled: true,
    },
  });

  // Новый бланк должен сразу попадать в карточки «Связанные документы».
  invalidateBlankCatalog();

  return NextResponse.json({
    success: true,
    template: {
      id: tpl.id,
      key: tpl.key,
      title: tpl.title,
      fields_count: fieldsSchema.length,
    },
  });
}
