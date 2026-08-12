import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildDocx, emptyPara, type DocxPara } from './docx';
import { DocValueError, cellToString, ru, saveGenerated, timestamp } from './common';
import { toDocsPath } from '@/lib/news';

/**
 * Б3: справка на работника из выгрузки 1С:ЗиК → читабельный docx.
 * Порт services/documents/employee_certificate.py. Без LLM.
 *
 * Правки по брифу УРП: «Повышение квалификации» — только за последние 3 года;
 * «Работа по окончании ВУЗа» — по ДОЛЖНОСТЯМ (подряд идущие приказы по той же
 * должности схлопываются, остаётся первая дата), служебные хвосты приказов
 * убираются.
 */

/** Триггер чат-команды «справка на работника» / «сделай справку читабельной». */
export const CERTIFICATE_EMP_REQUEST_RE = ru(
  'справк\\w*\\s+на\\s+(?:работник|сотрудник)|читабельн\\w+\\s+справк|преобразу\\w+\\s+справк',
  'i'
);

const DATE_RE = ru('^(\\d{2})\\.(\\d{2})\\.(\\d{4})\\b');
// Служебный хвост записи о работе: «0,5 Перемещение Основное место работы» и т.п.
const WORK_TAIL_RE =
  /[\s,]*\d+(?:[.,]\d+)?\s*(?:Перемещение|Прием|Приём|Увольнение)?\s*(?:Основное место работы|Внутреннее совместительство|Внешнее совместительство|Совместительство)?\s*$/i;
const PK_KEEP_YEARS = 3;

// Порядок и подписи полей в итоговой справке
const FIELD_ORDER = [
  'ФИО', 'Дата рождения', 'Занимаемая должность', 'Структурное подразделение',
  'Ученое звание', 'Ученая степень', 'Преподаваемые дисциплины', 'Телефоны',
  'Образование', 'Профессиональная переподготовка', 'Повышение квалификации',
  'Работа по окончании ВУЗа', 'Общий стаж', 'Общий научно-педагогический стаж',
  'Стаж работы в ТИУ', 'Поощрения и награды',
];
// Многострочные поля: каждая строка значения — отдельная запись-буллет
const LIST_FIELDS = new Set([
  'Образование', 'Повышение квалификации', 'Профессиональная переподготовка',
  'Работа по окончании ВУЗа', 'Поощрения и награды', 'Преподаваемые дисциплины',
]);

export type CertificateFields = Record<string, string | string[]>;

/** «Образование ⏎(ВУЗ, год…)» → «Образование» — канонизация имени поля. */
function normLabel(label: string): string {
  const head = (label || '').split(/[(\n]/)[0].trim().replace(/[ :]+$/, '');
  for (const canon of FIELD_ORDER) {
    if (head.toLowerCase().startsWith(canon.toLowerCase())) return canon;
  }
  return head;
}

/** Дата записи в начале строки как UTC-полночь; null — строка без даты. */
function recDate(line: string): number | null {
  const m = DATE_RE.exec(line.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  // date() в Python бросает ValueError на 31.02 — там это ловится и даёт None.
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? ts : null;
}

/** Пары «поле → значение» из выгрузки (первый/активный лист). */
export function parseCertificateRows(rows: unknown[][]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const row of rows) {
    const label = row.length && row[0] !== null && row[0] !== undefined ? cellToString(row[0]).trim() : '';
    const value =
      row.length > 1 && row[1] !== null && row[1] !== undefined ? cellToString(row[1]).trim() : '';
    if (!label || label.toLowerCase().includes('справка')) continue;
    fields[normLabel(label)] = value;
  }
  if (!fields['ФИО']) {
    throw new DocValueError('Файл не похож на выгрузку «Справка на сотрудника» из 1С:ЗиК');
  }
  return fields;
}

/** Повышение квалификации: только записи за последние 3 года. */
function filterPk(lines: string[], todayMs: number): string[] {
  const cutoff = todayMs - PK_KEEP_YEARS * 365 * 86_400_000;
  return lines.filter((ln) => {
    const d = recDate(ln);
    return d === null || d >= cutoff;
  });
}

/**
 * Работа по окончании ВУЗа → по должностям: подряд идущие записи одной
 * должности схлопываются, остаётся ПЕРВАЯ дата. Хвосты приказов убираются.
 */
function dedupWork(lines: string[]): string[] {
  const recs: [string, string][] = []; // (дата-строка, «Должность, Подразделение»)
  for (const raw of lines) {
    const ln = raw.trim();
    const m = DATE_RE.exec(ln);
    if (!m) {
      // перенос без даты — продолжение предыдущей записи
      if (recs.length) recs[recs.length - 1][1] = `${recs[recs.length - 1][1]} ${ln}`.trim();
      continue;
    }
    let rest = ln.slice(m[0].length).replace(/^[ ,;–-]+/, '');
    rest = rest.replace(WORK_TAIL_RE, '').replace(/^[ ,;]+/, '').replace(/[ ,;]+$/, '');
    rest = rest.replace(/\s+/g, ' ');
    recs.push([m[0], rest]);
  }

  const out: string[] = [];
  let prevKey: string | null = null;
  for (const [d, rest] of recs) {
    const key = rest.toLowerCase().replace(/[^а-яёa-z0-9]+/g, '');
    if (key && key === prevKey) continue; // тот же состав — пропускаем приказ
    prevKey = key;
    out.push(`${d} – ${rest}`);
  }
  return out;
}

/** Применяет правила брифа и раскладывает значения по виду (строка/список). */
export function buildCertificateFields(
  raw: Record<string, string>,
  todayMs = todayUtcMs()
): CertificateFields {
  const out: CertificateFields = {};
  for (const name of FIELD_ORDER) {
    const val = (raw[name] || '').trim();
    if (!val) continue;
    if (LIST_FIELDS.has(name)) {
      let lines = val
        .split(/\r\n|\r|\n/)
        .map((ln) => ln.trim().replace(/;+$/, ''))
        .filter((ln) => ln);
      if (name === 'Повышение квалификации') lines = filterPk(lines, todayMs);
      else if (name === 'Работа по окончании ВУЗа') lines = dedupWork(lines);
      else lines = lines.map((ln) => ln.replace(/^(\d{2}\.\d{2}\.\d{4})[\s,]+/, '$1 – '));
      if (lines.length) out[name] = lines;
    } else {
      out[name] = val;
    }
  }
  return out;
}

/** date.today() как UTC-полночь — сравнение дат идёт в одной шкале. */
function todayUtcMs(): number {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}

async function renderCertificateDocx(fields: CertificateFields): Promise<string> {
  const paras: DocxPara[] = [
    { runs: [{ text: 'СПРАВКА НА СОТРУДНИКА', bold: true, sizePt: 14 }], align: 'center' },
    emptyPara(),
  ];
  for (const name of FIELD_ORDER) {
    const val = fields[name];
    if (val === undefined) continue;
    if (typeof val === 'string') {
      paras.push({ runs: [{ text: `${name}: `, bold: true }, { text: val }] });
    } else {
      // Список: подпись отдельным абзацем, записи — с отступом (как в python-docx,
      // где add_paragraph внутри цикла создаёт новые абзацы после подписи).
      paras.push({ runs: [{ text: `${name}: `, bold: true }] });
      for (const ln of val) {
        paras.push({ runs: [{ text: ln }], leftIndentPt: 20, spaceAfterPt: 2 });
      }
    }
  }
  return saveGenerated(`certificate_${timestamp()}.docx`, buildDocx(paras));
}

export async function createCertificate(userId: number, rows: unknown[][]) {
  const raw = parseCertificateRows(rows);
  const fields = buildCertificateFields(raw);
  const filePath = await renderCertificateDocx(fields);
  const fio = (raw['ФИО'] || '').trim();
  const rec = await prisma.my_documents.create({
    data: {
      user_id: userId,
      // «Х» в начале ФИО — обезличенный образец выгрузки, его в заголовок не выносим.
      title: fio && !fio.slice(0, 3).includes('Х') ? `Справка на сотрудника: ${fio}` : 'Справка на сотрудника',
      template_key: 'employee_certificate',
      file_path: toDocsPath(filePath),
      progress: 100,
      status: 'ready',
      fields: { fio } as Prisma.InputJsonValue,
      is_pii: true, // ПДн работника — документ не хранится (автоудаление)
    },
  });
  return { rec, fields };
}
