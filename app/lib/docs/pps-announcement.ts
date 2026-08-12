import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildDocx, emptyPara, type DocxPara } from './docx';
import { DocValueError, cellToString, ru, saveGenerated, timestamp } from './common';
import { toDocsPath } from '@/lib/news';

/**
 * Б5: объявление на конкурс ППС из выгрузок 1С:ЗиК «Форма 2».
 * Порт services/documents/pps_announcement.py. Без LLM.
 *
 * По одному файлу на должность; внутри люди сгруппированы строками-заголовками
 * институт → кафедра. Скобки требований — черновик для правки кадровиком в Word.
 */

/** Триггер чат-команды «объявление о конкурсе ППС / выборах заведующих». */
export const PPS_REQUEST_RE = ru(
  'объявлени\\w*[^.]{0,50}(?:конкурс|ппс|выбор)|конкурс[^.]{0,20}ппс|выбор\\w*\\s+завед',
  'i'
);

// Порядок секций объявления; ключ — по подстроке в названии должности.
const SECTION_ORDER: [string, string][] = [
  ['заведующ', 'ВЫБОРЫ\nЗАВЕДУЮЩИХ КАФЕДРАМИ:'],
  ['профессор', 'ПРОФЕССОРОВ КАФЕДР:'],
  ['доцент', 'ДОЦЕНТОВ КАФЕДР:'],
  ['старший преподаватель', 'СТАРШИХ ПРЕПОДАВАТЕЛЕЙ КАФЕДР:'],
  ['преподаватель', 'ПРЕПОДАВАТЕЛЕЙ КАФЕДР:'],
  ['ассистент', 'АССИСТЕНТОВ КАФЕДР:'],
];

const TITLE_RE = /на должность\s*[-–—]\s*(.+)/i;
const DEGREE_RE = /(доктор|кандидат)\s+[а-яё-]+\s+наук/i;
const DEPT_HEAD_RE = ru('^(базовая\\s+)?кафедра\\b', 'i');

interface Form2Row {
  fio: string;
  institute: string;
  department: string;
  degree: string;
  specialties: string;
}
export interface Form2 {
  position: string;
  rows: Form2Row[];
}

function sectionKey(position: string): string {
  const low = (position || '').toLowerCase();
  for (const [key] of SECTION_ORDER) {
    if (low.includes(key)) return key;
  }
  return 'прочие';
}

/**
 * Один файл «Форма 2» → {position, rows}. Группировка институт/кафедра —
 * по строкам-заголовкам (в строке ровно одно непустое значение).
 */
export function parseForm2Rows(rows: unknown[][], filename: string): Form2 {
  let position: string | null = null;
  let headerRow: number | null = null;
  const cols: Record<string, number> = {};

  for (let ri = 0; ri < Math.min(rows.length, 25); ri += 1) {
    const row = rows[ri];
    if (position === null) {
      const joined = row.filter((v) => v !== null && v !== undefined).map(cellToString).join(' ');
      const m = TITLE_RE.exec(joined);
      if (m) position = m[1].replace(/\s+/g, ' ').trim();
    }
    const low = row.map((v) => (v === null || v === undefined ? '' : cellToString(v).trim().toLowerCase()));
    if (low.some((c) => c.includes('фамилия'))) {
      headerRow = ri;
      low.forEach((c, ci) => {
        if (c.includes('фамилия')) cols.fio = ci;
        else if (c.includes('ученая степень') || c.includes('учёная степень')) cols.degree = ci;
        else if (c.includes('специальность')) cols.spec = ci;
        else if (c === 'должность') cols.position = ci;
      });
      break;
    }
  }
  if (headerRow === null || cols.fio === undefined) {
    throw new DocValueError(`${filename}: не похоже на «Форму 2» (нет шапки с ФИО)`);
  }

  const out: Form2Row[] = [];
  let institute = '';
  let department = '';
  for (const row of rows.slice(headerRow + 1)) {
    const vals = row.filter((v) => v !== null && v !== undefined && cellToString(v).trim());
    if (!vals.length) continue;
    // Строка-заголовок группы (институт/кафедра) — объединённая ячейка.
    if (vals.length === 1) {
      const text = cellToString(vals[0]).replace(/\s+/g, ' ').trim();
      if (DEPT_HEAD_RE.test(text)) {
        department = text;
      } else {
        institute = text;
        department = '';
      }
      continue;
    }
    const fioCell = cols.fio < row.length ? row[cols.fio] : null;
    if (fioCell === null || fioCell === undefined || !cellToString(fioCell).trim()) continue;
    const pick = (key: string): string => {
      const i = cols[key];
      if (i === undefined || i >= row.length) return '';
      const v = row[i];
      return v ? cellToString(v).trim() : '';
    };
    out.push({
      fio: cellToString(fioCell).replace(/\s+/g, ' ').trim(),
      institute,
      department: department || institute,
      degree: pick('degree'),
      specialties: pick('spec'),
    });
  }
  if (!out.length) {
    throw new DocValueError(`${filename}: в «Форме 2» не нашлось строк с работниками`);
  }
  return { position: position || '', rows: out };
}

/** «Кафедра интеллектуальных систем» → «интеллектуальных систем». */
function deptDisplay(department: string): string {
  const d = department.trim().replace(/^(базовая\s+)?кафедра\s+/i, '');
  return d ? d.slice(0, 1).toLowerCase() + d.slice(1) : department;
}

/** Черновик требований по одному работнику: образование + степень. */
function personProfile(row: Form2Row): string {
  const bits: string[] = [];
  const specs = row.specialties
    .split(/[\n;]/)
    .filter((s) => s.trim())
    .map((s) => s.replace(/^[ \-–]+/, '').replace(/[ \-–]+$/, ''));
  if (specs.length) {
    // «Программное обеспечение…-Инженер» → специальность до «-квалификация»
    const names: string[] = [];
    for (const s of specs.slice(0, 2)) {
      const name = s.split(/\s*-\s*(?=[А-ЯЁ][а-яё]+$)/)[0].trim();
      if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    if (names.length) {
      const quoted = names.map((n) => `«${n}»`).join(', ');
      bits.push(
        names.length === 1
          ? `образование высшее по специальности ${quoted}`
          : `образование высшее по специальностям: ${quoted}`
      );
    }
  } else {
    bits.push('образование высшее');
  }
  const m = DEGREE_RE.exec(row.degree || '');
  if (m) bits.push(m[0].toLowerCase());
  else if (row.degree) bits.push(row.degree.toLowerCase());
  return bits.join(', ');
}

export interface AnnouncementData {
  date: string;
  sections: [string, [string, string][]][];
  positions: number;
  departments: number;
  people: number;
}

/** Собирает секции объявления из разобранных «форм 2». */
export function buildAnnouncement(form2List: Form2[], today = new Date()): AnnouncementData {
  const sections = new Map<string, Map<string, string[]>>();
  let people = 0;
  for (const f2 of form2List) {
    const key = sectionKey(f2.position);
    let depts = sections.get(key);
    if (!depts) {
      depts = new Map();
      sections.set(key, depts);
    }
    for (const row of f2.rows) {
      people += 1;
      const disp = deptDisplay(row.department);
      const profile = key === 'заведующ' ? 'наличие ученой степени и ученого звания' : personProfile(row);
      let lst = depts.get(disp);
      if (!lst) {
        lst = [];
        depts.set(disp, lst);
      }
      if (profile && !lst.includes(profile)) lst.push(profile);
    }
  }

  const ordered: [string, [string, string][]][] = [];
  for (const [key, header] of SECTION_ORDER) {
    const depts = sections.get(key);
    if (!depts) continue;
    const lines = [...depts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([dept, profiles]) => [dept, profiles.join('; ')] as [string, string]);
    ordered.push([header, lines]);
  }

  const two = (n: number) => String(n).padStart(2, '0');
  const allDepts = new Set<string>();
  for (const depts of sections.values()) for (const d of depts.keys()) allDepts.add(d);

  return {
    date: `${two(today.getDate())}.${two(today.getMonth() + 1)}.${today.getFullYear()}`,
    sections: ordered,
    positions: form2List.length,
    departments: allDepts.size,
    people,
  };
}

const FOOTER_PARAGRAPHS = [
  'Претенденты для участия в выборах на должности заведующих кафедрами предоставляют ' +
    'документы в соответствии с пунктами 3.5 и 3.6 Порядка выборов на должность заведующего ' +
    'кафедрой ТИУ от 29.06.2020 года (с изменениями от 10.08.2022 года), размещенного на сайте ТИУ.',
  'Заявления и необходимые документы для участия в выборах направлять по адресу ' +
    'г. Тюмень, ул. Володарского, 38, каб. 106.',
  'Претенденты для участия в конкурсе на должности педагогических работников, относящихся ' +
    'к профессорско-преподавательскому составу (ППС), предоставляют документы в соответствии ' +
    'с Положением о порядке замещения должностей педагогических работников, относящихся к ' +
    'профессорско-преподавательскому составу (утверждено приказом Министерства науки и высшего ' +
    'образования РФ от 04.12.2023 г. № 1138), и Порядком замещения должностей педагогических ' +
    'работников ТИУ, относящихся к профессорско-преподавательскому составу, размещенными на сайте ТИУ.',
  'С претендентами, прошедшими конкурс на замещение должностей ППС, заключается трудовой ' +
    'договор/дополнительное соглашение к трудовому договору на срок не менее трёх лет и не ' +
    'более пяти лет.',
  'Заявления и необходимые документы для участия в конкурсе направлять на согласование в ' +
    'системе 1С: Документооборот (претендентам, не являющимся работниками ТИУ, — направлять ' +
    'по адресу г. Тюмень, ул. Володарского, 38, каб. 106).',
  'Срок подачи заявлений об участии в выборах и конкурсе – один месяц со дня опубликования ' +
    'объявления.',
  'тел. для справок: 28-35-60, вн. 11-35',
];

async function renderAnnouncementDocx(data: AnnouncementData): Promise<string> {
  const paras: DocxPara[] = [];
  for (const line of [
    'ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ ОБРАЗОВАТЕЛЬНОЕ УЧРЕЖДЕНИЕ ВЫСШЕГО ОБРАЗОВАНИЯ',
    '«ТЮМЕНСКИЙ ИНДУСТРИАЛЬНЫЙ УНИВЕРСИТЕТ»',
  ]) {
    paras.push({ runs: [{ text: line, bold: true }], align: 'center' });
  }
  paras.push({ runs: [{ text: `г. Тюмень\t${data.date}` }], tabStopsPt: [460] });
  paras.push({ runs: [{ text: 'ОБЪЯВЛЯЕТ', bold: true, sizePt: 14 }], align: 'center' });

  let firstKonkurs = true;
  for (const [header, lines] of data.sections) {
    if (!header.startsWith('ВЫБОРЫ') && firstKonkurs) {
      paras.push({ runs: [{ text: 'КОНКУРС НА ЗАМЕЩЕНИЕ ДОЛЖНОСТЕЙ', bold: true }], align: 'center' });
      firstKonkurs = false;
    }
    for (const hline of header.split('\n')) {
      paras.push({ runs: [{ text: hline, bold: true }], align: 'center' });
    }
    for (const [dept, req] of lines) {
      paras.push({ runs: [{ text: `${dept} (${req});` }], leftIndentPt: 18, spaceAfterPt: 2 });
    }
    paras.push(emptyPara());
  }
  for (const text of FOOTER_PARAGRAPHS) paras.push({ runs: [{ text }] });

  return saveGenerated(`pps_announcement_${timestamp()}.docx`, buildDocx(paras));
}

/** Полный цикл: файлы «Форма 2» (по одному на должность) → word-объявление. */
export async function createAnnouncement(userId: number, form2List: Form2[]) {
  const data = buildAnnouncement(form2List);
  const filePath = await renderAnnouncementDocx(data);
  const rec = await prisma.my_documents.create({
    data: {
      user_id: userId,
      title: `Объявление о конкурсе ППС от ${data.date}`,
      template_key: 'pps_announcement',
      file_path: toDocsPath(filePath),
      progress: 100,
      status: 'ready',
      fields: { positions: data.positions, departments: data.departments } as Prisma.InputJsonValue,
      is_pii: false, // значение по умолчанию модели MyDocuments
    },
  });
  return { rec, data };
}
