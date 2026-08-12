import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';
import { badRequest } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { baseName, suffixOf, validationError } from '@/lib/news';
import { BAD_DATE, parseBirthDate, piiLog, requirePiiAccess } from '@/lib/pii';

// Импорт карточек сотрудников из табличной выгрузки 1С (CSV/XLSX/XLS/ODS).
// Порт POST /api/pii/import/1c из backend/routes/pii.py (import_1c_persons,
// _parse_person_table, _rows_from_table, _detect_person_columns).
//
// Персональные данные идут в раздел ПДн, НЕ в LLM/RAG (#18) — файл нигде не
// сохраняется, из него берутся только ФИО и дата рождения.

const MAX_BYTES = 30 * 1024 * 1024; // 30 МБ
const ALLOWED_EXT = new Set(['.csv', '.xlsx', '.xls', '.ods']);

// Порядок важен: колонка достаётся первому подошедшему ключу (dict в Python
// сохраняет порядок объявления).
const PERSON_COL_ALIASES: [string, string[]][] = [
  ['surname', ['фамилия', 'surname', 'lastname', 'last_name']],
  ['name', ['имя', 'name', 'firstname', 'first_name']],
  ['patronymic', ['отчество', 'patronymic', 'middlename', 'middle_name']],
  [
    'birth_date',
    ['дата рождения', 'датарождения', 'дата_рождения', 'birth_date', 'birthdate', 'birthday', 'др'],
  ],
  ['fullname', ['фио', 'ф.и.о', 'сотрудник', 'fullname', 'full_name', 'физлицо', 'физическое лицо']],
];

/** Колонка подходит при точном совпадении заголовка ИЛИ вхождении алиаса в него. */
function detectPersonColumns(header: string[]): Map<string, number> {
  const norm = header.map((h) => (h || '').trim().toLowerCase());
  const mapping = new Map<string, number>();
  for (const [key, aliases] of PERSON_COL_ALIASES) {
    for (let i = 0; i < norm.length; i += 1) {
      if (aliases.includes(norm[i]) || aliases.some((a) => norm[i].includes(a))) {
        mapping.set(key, i);
        break;
      }
    }
  }
  return mapping;
}

// ── CSV ────────────────────────────────────────────────────────────────────

/** decode("utf-8-sig", errors="ignore"): BOM снимаем, битые байты выбрасываем. */
function decodeUtf8Sig(data: Buffer): string {
  // Node подставляет вместо битых байт U+FFFD — убираем его, чтобы результат
  // совпал с errors="ignore" (тот же приём, что в lib/parsers).
  const text = data.toString('utf8').replace(/\uFFFD/g, '');
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

type CsvState =
  | 'start_record'
  | 'start_field'
  | 'in_field'
  | 'in_quoted'
  | 'quote_in_quoted'
  | 'eat_crnl';

/**
 * Порт csv.reader (Modules/_csv.c) для диалекта по умолчанию: кавычки значимы
 * только в начале поля, «""» внутри — литеральная кавычка, перевод строки
 * внутри кавычек — часть значения. Пустая строка даёт пустую запись.
 *
 * Написан вручную, а не через SheetJS: у того собственные эвристики (угадывание
 * разделителя, строка «sep=», приведение типов), из-за которых разбор разошёлся
 * бы с Python на неочевидных файлах.
 */
function readCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = '';

  const save = () => {
    fields.push(field);
    field = '';
  };
  const isEol = (c: string) => c === '\n' || c === '\r';

  // Один символ автомата. '\0' — маркер конца строки, который csv.reader
  // подставляет сам после каждой прочитанной строки.
  const step = (s: CsvState, c: string): CsvState => {
    if (s === 'start_record') {
      if (c === '\0') return 'start_record';
      if (isEol(c)) return 'eat_crnl';
      s = 'start_field';
    }
    if (s === 'start_field') {
      if (c === '\0' || isEol(c)) {
        save();
        return c === '\0' ? 'start_record' : 'eat_crnl';
      }
      if (c === '"') return 'in_quoted';
      if (c === delim) {
        save();
        return 'start_field';
      }
      field += c;
      return 'in_field';
    }
    if (s === 'in_field') {
      if (c === '\0' || isEol(c)) {
        save();
        return c === '\0' ? 'start_record' : 'eat_crnl';
      }
      if (c === delim) {
        save();
        return 'start_field';
      }
      field += c;
      return 'in_field';
    }
    if (s === 'in_quoted') {
      if (c === '\0') return 'in_quoted'; // конец строки внутри кавычек — поле продолжается
      if (c === '"') return 'quote_in_quoted';
      field += c;
      return 'in_quoted';
    }
    if (s === 'quote_in_quoted') {
      if (c === '"') {
        field += '"';
        return 'in_quoted';
      }
      if (c === delim) {
        save();
        return 'start_field';
      }
      if (c === '\0' || isEol(c)) {
        save();
        return c === '\0' ? 'start_record' : 'eat_crnl';
      }
      field += c; // не strict: мусор после кавычки — обычный текст
      return 'in_field';
    }
    if (isEol(c)) return 'eat_crnl';
    if (c === '\0') return 'start_record';
    // Текст ошибки уходит в ответ («Не удалось разобрать таблицу: …») — берём
    // его дословно из _csv.Error текущего Python (3.12).
    throw new Error(
      "new-line character seen in unquoted field - do you need to open the file with newline=''?"
    );
  };

  // StringIO(text) с newline='\n': строки режутся только по '\n', перевод
  // строки остаётся в строке, лишней пустой строки в конце не возникает.
  const parts = text.split('\n');
  const lines = parts.map((p, i) => (i < parts.length - 1 ? `${p}\n` : p));
  if (lines[lines.length - 1] === '') lines.pop();

  let state: CsvState = 'start_record';
  for (const line of lines) {
    for (const c of line) state = step(state, c);
    state = step(state, '\0');
    if (state === 'start_record') {
      rows.push(fields);
      fields = [];
    }
  }
  // Незакрытая кавычка в конце файла: csv.reader всё равно отдаёт запись.
  if (state === 'in_quoted' || field !== '') {
    save();
    rows.push(fields);
  }
  return rows;
}

// ── Excel/ODS ──────────────────────────────────────────────────────────────

// SSF в типах пакета объявлен как any — сужаем до того, что реально нужно.
const ssf = XLSX.SSF as {
  is_date: (fmt: string) => boolean;
  parse_date_code: (
    v: number
  ) => { y: number; m: number; d: number; H: number; M: number; S: number } | null;
};

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function dateTimeString(y: number, m: number, d: number, H: number, M: number, S: number): string {
  return `${y}-${two(m)}-${two(d)} ${two(H)}:${two(M)}:${two(S)}`;
}

/**
 * `str(cell)` как в openpyxl: дата — «YYYY-MM-DD HH:MM:SS», bool — True/False.
 *
 * Дату собираем из серийного номера Excel, а не из опции cellDates: SheetJS
 * строит Date через локальную зону, а в зонах с дробным LMT-смещением
 * (Asia/Yekaterinburg и подобные) промахивается на десятки секунд.
 */
function cellToString(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === null || cell.v === undefined) return '';
  if (cell.t === 'b') return cell.v ? 'True' : 'False';
  if (cell.t === 'd' && cell.v instanceof Date) {
    const v = cell.v;
    return dateTimeString(
      v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(),
      v.getUTCHours(), v.getUTCMinutes(), v.getUTCSeconds()
    );
  }
  // Число с форматом даты — у openpyxl это datetime, а не «45324».
  if (cell.t === 'n' && typeof cell.v === 'number' && cell.z && ssf.is_date(String(cell.z))) {
    const p = ssf.parse_date_code(cell.v);
    if (p) return dateTimeString(p.y, p.m, p.d, p.H, p.M, p.S);
  }
  return String(cell.v);
}

function rowsFromSheet(data: Buffer): string[][] {
  // cellNF: без строки формата не отличить дату от обычного числа.
  const wb = XLSX.read(data, { type: 'buffer', cellNF: true });
  // openpyxl берёт wb.active; SheetJS активный лист при чтении не сохраняет,
  // поэтому берём первый — в выгрузках 1С это один и тот же лист.
  const ws = wb.SheetNames.length ? wb.Sheets[wb.SheetNames[0]] : undefined;
  const ref = ws?.['!ref'];
  if (!ws || !ref) return [];

  // Обход по диапазону листа, как ws.iter_rows(values_only=True): пустые строки
  // и пустые ячейки сохраняются, иначе съедет определение колонок по шапке.
  const range = XLSX.utils.decode_range(ref);
  const rows: string[][] = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      row.push(cellToString(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined));
    }
    rows.push(row);
  }
  return rows;
}

// ── Разбор таблицы ─────────────────────────────────────────────────────────

interface ImportedPerson {
  surname: string;
  name: string;
  patronymic: string | null;
  birth_date: string | null;
}

function parsePersonTable(data: Buffer, suffix: string): ImportedPerson[] {
  let table: string[][];
  if (suffix === '.csv') {
    const text = decodeUtf8Sig(data);
    const sample = text.slice(0, 2000);
    const count = (s: string, ch: string) => s.split(ch).length - 1;
    const delim = count(sample, ';') >= count(sample, ',') ? ';' : ',';
    table = readCsv(text, delim);
  } else {
    table = rowsFromSheet(data);
  }

  if (!table.length) return [];
  const cols = detectPersonColumns(table[0]);
  if (!cols.size) return [];
  // Шапку пропускаем, только если нашлась колонка с ФИО: таблица, где узналась
  // одна «Дата рождения», разбирается с первой строки — как в Python.
  const hasHeader = ['surname', 'name', 'fullname'].some((k) => cols.has(k));

  const out: ImportedPerson[] = [];
  for (const raw of table.slice(hasHeader ? 1 : 0)) {
    const cell = (key: string): string => {
      const i = cols.get(key);
      if (i === undefined || i >= raw.length) return '';
      return (raw[i] ?? '').trim();
    };

    let surname = cell('surname');
    let name = cell('name');
    let patronymic = cell('patronymic');
    const birthDate = cell('birth_date');

    if (!surname && cols.has('fullname')) {
      const parts = cell('fullname').split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        surname = parts[0];
        name = parts[1];
        patronymic = parts.length >= 3 ? parts[2] : '';
      }
    }
    if (surname && name) {
      out.push({
        surname,
        name,
        patronymic: patronymic || null,
        birth_date: birthDate || null,
      });
    }
  }
  return out;
}

export async function POST(request: NextRequest) {
  const gate = await requirePiiAccess();
  if ('response' in gate) return gate.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return validationError(['body', 'file'], 'missing', 'Field required', null);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return validationError(['body', 'file'], 'missing', 'Field required', null);
  }

  // Здесь Python берёт Path(...).suffix, а не rsplit, как в загрузке документов.
  const suffix = suffixOf(baseName(file.name || '')).toLowerCase();
  if (!ALLOWED_EXT.has(suffix)) {
    return badRequest('Ожидается таблица сотрудников из 1С (CSV/XLSX/XLS/ODS)');
  }

  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > MAX_BYTES) return badRequest('Файл больше 30 МБ');

  let persons: ImportedPerson[];
  try {
    persons = parsePersonTable(data, suffix);
  } catch (e) {
    return badRequest(`Не удалось разобрать таблицу: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!persons.length) {
    return badRequest('Не найдены сотрудники. Нужны колонки «Фамилия»+«Имя» или «ФИО».');
  }

  let created = 0;
  let skipped = 0;
  for (const r of persons) {
    // Битая дата в выгрузке не роняет импорт: карточка заводится без неё.
    const parsed = parseBirthDate(r.birth_date);
    const birthDate = parsed === BAD_DATE ? null : parsed;

    // Дубли внутри самого файла тоже отсекаются: запись создаётся сразу и
    // находится этим же запросом на следующей строке (в Python — autoflush).
    const existing = await prisma.pii_persons.findFirst({
      where: {
        surname: r.surname,
        name: r.name,
        patronymic: r.patronymic,
        birth_date: birthDate,
      },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    await prisma.pii_persons.create({
      data: { surname: r.surname, name: r.name, patronymic: r.patronymic, birth_date: birthDate },
    });
    created += 1;
  }

  await piiLog(gate.user.id, 'import_1c', { entity: 'person', extra: { created, skipped } });
  return NextResponse.json({ success: true, created, skipped });
}
