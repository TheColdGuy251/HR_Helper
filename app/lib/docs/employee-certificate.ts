import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildDocx, emptyPara, type DocxPara } from './docx';
import { DocValueError, cellToString, ru, saveGenerated, timestamp } from './common';
import type { WorkbookPhoto } from './workbook-image';

/**
 * Б3: справка на работника из выгрузки 1С:ЗиК -> читабельный docx.
 * Без LLM.
 *
 * Правки по брифу УРП: "Повышение квалификации" - только за последние 3 года;
 * "Работа по окончании ВУЗа" - по должностям (подряд идущие приказы по той же
 * должности схлопываются, остаётся первая дата), служебные хвосты приказов
 * убираются.
 *
 * Правки по отзыву УРП от 21.07: слева сверху - фото работника из выгрузки
 * (либо пустая рамка-место под фото, если в книге его нет). Подозрительные
 * значения (дата рождения "16.11.0000" и т.п.) не блокируют формирование,
 * а возвращаются списком предупреждений.
 */

/** Триггер чат-команды "справка на работника" / "сделай справку читабельной". */
export const CERTIFICATE_EMP_REQUEST_RE = ru(
  'справк\\w*\\s+на\\s+(?:работник|сотрудник)|читабельн\\w+\\s+справк|преобразу\\w+\\s+справк',
  'i'
);

const DATE_RE = ru('^(\\d{2})\\.(\\d{2})\\.(\\d{4})\\b');
// Служебный хвост записи о работе: "0,5 Перемещение Основное место работы" и т.п.
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
// Многострочные поля: каждая строка значения - отдельная запись-буллет
const LIST_FIELDS = new Set([
  'Образование', 'Повышение квалификации', 'Профессиональная переподготовка',
  'Работа по окончании ВУЗа', 'Поощрения и награды', 'Преподаваемые дисциплины',
]);

export type CertificateFields = Record<string, string | string[]>;

/** "Образование\n(ВУЗ, год...)" -> "Образование" - канонизация имени поля. */
function normLabel(label: string): string {
  const head = (label || '').split(/[(\n]/)[0].trim().replace(/[ :]+$/, '');
  for (const canon of FIELD_ORDER) {
    if (head.toLowerCase().startsWith(canon.toLowerCase())) return canon;
  }
  return head;
}

/** Дата записи в начале строки как UTC-полночь; null - строка без даты. */
function recDate(line: string): number | null {
  const m = DATE_RE.exec(line.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  // Несуществующая дата (31.02) - null.
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? ts : null;
}

/** Пары "поле -> значение" из выгрузки (первый/активный лист). */
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
 * Работа по окончании ВУЗа -> по должностям: подряд идущие записи одной
 * должности схлопываются, остаётся первая дата. Хвосты приказов убираются.
 */
function dedupWork(lines: string[]): string[] {
  const recs: [string, string][] = []; // (дата-строка, "Должность, Подразделение")
  for (const raw of lines) {
    const ln = raw.trim();
    const m = DATE_RE.exec(ln);
    if (!m) {
      // перенос без даты - продолжение предыдущей записи
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
    if (key && key === prevKey) continue; // тот же состав - пропускаем приказ
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

/** date.today() как UTC-полночь - сравнение дат идёт в одной шкале. */
function todayUtcMs(): number {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}

// Валидация значений (только предупреждения, ничего не блокируем)

/** Поля, без которых справка выглядит неполной. */
const EXPECTED_FIELDS = ['Дата рождения', 'Занимаемая должность', 'Структурное подразделение'];

/** Правдоподобный год для дат в справке (рождение, приказы, обучение). */
function plausibleYear(y: number, todayMs: number): boolean {
  return y >= 1900 && y <= new Date(todayMs).getUTCFullYear() + 1;
}

/**
 * Проверяет значения выгрузки и возвращает список предупреждений для
 * пользователя. Формирование документа не прерывается: HR видит, что именно
 * стоит перепроверить (например, "Дата рождения: 16.11.0000" из обезличенной
 * выгрузки).
 */
export function validateCertificate(
  raw: Record<string, string>,
  todayMs = todayUtcMs()
): string[] {
  const warnings: string[] = [];

  for (const name of EXPECTED_FIELDS) {
    if (!(raw[name] || '').trim()) warnings.push(`В выгрузке нет поля «${name}»`);
  }

  const birth = (raw['Дата рождения'] || '').trim();
  if (birth) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(birth);
    const ts = recDate(birth);
    const year = m ? Number(m[3]) : NaN;
    // Правдоподобный возраст работника - от 14 лет.
    const maxBirthYear = new Date(todayMs).getUTCFullYear() - 14;
    if (ts === null || !plausibleYear(year, todayMs) || year > maxBirthYear) {
      warnings.push(`Дата рождения выглядит некорректно: «${birth}» — проверьте значение в выгрузке`);
    }
  }

  // Строки-списки, начинающиеся "как дата", но с невозможной датой.
  for (const name of ['Повышение квалификации', 'Работа по окончании ВУЗа', 'Поощрения и награды', 'Образование']) {
    const val = (raw[name] || '').trim();
    if (!val) continue;
    const bad: string[] = [];
    for (const line of val.split(/\r\n|\r|\n/)) {
      const ln = line.trim();
      const m = /^(\d{2})\.(\d{2})\.(\d{2,4})\b/.exec(ln);
      if (!m) continue; // строка без даты в начале - не проверяем
      if (m[3].length !== 4 || recDate(ln) === null || !plausibleYear(Number(m[3]), todayMs)) {
        bad.push(ln.slice(0, 40));
      }
    }
    if (bad.length) {
      warnings.push(
        `«${name}»: ${bad.length} ${bad.length === 1 ? 'запись' : 'записи(-ей)'} с сомнительной датой ` +
          `(например: «${bad[0]}…»)`
      );
    }
  }

  return warnings;
}

// Фото

// Рамка под фото - 35x45 мм ("на паспорт"), слева сверху; размеры пока
// прикидочные, УРП уточнит по образцу. 1 мм ~ 2.8346 pt.
const PHOTO_BOX_W_PT = 100;
const PHOTO_BOX_H_PT = 128;
const PHOTO_PAD_PT = 4;

/** Абзац-рамка с фото (вписанным по пропорциям) либо пустым местом под него. */
function photoPara(photo: WorkbookPhoto | null): DocxPara {
  const frame = { widthPt: PHOTO_BOX_W_PT, heightPt: PHOTO_BOX_H_PT, border: true };
  if (!photo || photo.width <= 0 || photo.height <= 0) {
    return {
      frame,
      align: 'center',
      runs: [{ text: '\n\nМесто\nдля фото', italic: true, sizePt: 10 }],
    };
  }
  const availW = PHOTO_BOX_W_PT - 2 * PHOTO_PAD_PT;
  const availH = PHOTO_BOX_H_PT - 2 * PHOTO_PAD_PT;
  const scale = Math.min(availW / photo.width, availH / photo.height);
  return {
    frame,
    align: 'center',
    runs: [
      {
        text: '',
        image: {
          data: photo.data,
          ext: photo.ext,
          widthPt: Math.max(1, photo.width * scale),
          heightPt: Math.max(1, photo.height * scale),
        },
      },
    ],
  };
}

async function renderCertificateDocx(
  fields: CertificateFields,
  photo: WorkbookPhoto | null
): Promise<string> {
  const paras: DocxPara[] = [
    // Плавающая рамка: фото слева сверху, заголовок и поля обтекают справа.
    photoPara(photo),
    { runs: [{ text: 'СПРАВКА НА СОТРУДНИКА', bold: true, sizePt: 14 }], align: 'center' },
    emptyPara(),
  ];
  for (const name of FIELD_ORDER) {
    const val = fields[name];
    if (val === undefined) continue;
    if (typeof val === 'string') {
      paras.push({ runs: [{ text: `${name}: `, bold: true }, { text: val }] });
    } else {
      // Список: подпись отдельным абзацем, записи - новыми абзацами с отступом
      // после подписи.
      paras.push({ runs: [{ text: `${name}: `, bold: true }] });
      for (const ln of val) {
        paras.push({ runs: [{ text: ln }], leftIndentPt: 20, spaceAfterPt: 2 });
      }
    }
  }
  return saveGenerated(`certificate_${timestamp()}.docx`, buildDocx(paras));
}

export async function createCertificate(
  userId: string,
  rows: unknown[][],
  photo: WorkbookPhoto | null = null
) {
  const raw = parseCertificateRows(rows);
  const fields = buildCertificateFields(raw);
  const warnings = validateCertificate(raw);
  const filePath = await renderCertificateDocx(fields, photo);
  const fio = (raw['ФИО'] || '').trim();
  const rec = await prisma.my_documents.create({
    data: {
      user_id: userId,
      // "Х" в начале ФИО - обезличенный образец выгрузки, его в заголовок не выносим.
      title: fio && !fio.slice(0, 3).includes('Х') ? `Справка на сотрудника: ${fio}` : 'Справка на сотрудника',
      generator: 'employee_certificate',
      file_path: filePath,
      progress: 100,
      status: 'ready',
      fields: { fio } as Prisma.InputJsonValue,
      is_pii: true, // ПДн работника - документ не хранится (автоудаление)
    },
  });
  return { rec, fields, warnings, photoUsed: Boolean(photo) };
}
