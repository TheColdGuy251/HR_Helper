import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildDocx, type DocxPara } from './docx';
import { DocValueError, mostCommon, ru, saveGenerated, timestamp } from './common';
import { toDocsPath } from '@/lib/news';

/**
 * Б2: отчёт по ДПО из выгрузки 1С:ЗиК «ПК за период».
 * Порт services/documents/dpo_report.py.
 *
 * ВАЖНО: 1С группирует строки по человеку — ФИО заполнено только в ПЕРВОЙ
 * строке блока, дальше forward-fill. Все числа считаются ДЕТЕРМИНИРОВАННО из
 * таблицы: в отчёте недопустимы «примерные» цифры LLM.
 */

/** Триггер чат-команды «отчёт по ДПО» / «отчёт о повышении квалификации». */
export const DPO_REQUEST_RE = ru(
  '(отч[её]т\\w*[^.\\n]{0,50}(\\bдпо\\b|повышени\\w*\\s+квалификац))' +
    '|((\\bдпо\\b|повышени\\w*\\s+квалификац)[^.\\n]{0,50}отч[её]т)',
  'i'
);

const HEADER_MARKERS = ['физическое лицо', 'категория должности'];
const SHORT_HOURS = 16; // порог «краткосрочной» программы

// Категории должностей → группы образца отчёта (считаются по УНИКАЛЬНЫМ людям).
const CATEGORY_GROUPS: [string, string[], string][] = [
  ['ППС', ['ППС'], 'профессорско-преподавательский состав (ППС)'],
  ['ПС и ПР', ['ПС', 'ПР'], 'педагогические работники СПО и СОО (ПС и ПР)'],
  ['НР', ['НР', 'НТР'], 'научные и научно-технические работники (НР, НТР)'],
  ['АУП', ['АУП', 'АУПН'], 'административно-управленческий персонал (АУП, АУПН)'],
  ['УВП', ['УВП', 'ПУП'], 'учебно-вспомогательный персонал (УВП, ПУП)'],
  ['ИТР', ['ИТР', 'ПРОП'], 'инженерно-технические работники (ИТР, ПрОП)'],
  ['АХП', ['АХП', 'АХПН'], 'административно-хозяйственный персонал (АХП, АХПН)'],
];

// Виды образования (по записям с часами >= 16, как в образце).
const KIND_LABELS: [string, string][] = [
  ['Профессиональная переподготовка', 'по программам профессиональной переподготовки'],
  ['Профессиональное обучение', 'по программам профессионального обучения'],
  ['Повышение квалификации', 'по программам повышения квалификации'],
];

// Обязательные программы (перечень образца) → ключи поиска в «Теме».
const MANDATORY: [string, RegExp][] = [
  ['Оказание первой помощи', ru('перв\\w*\\s+помощ', 'i')],
  ['Противодействие коррупции', /коррупц/i],
  ['Обучение инвалидов и лиц с ОВЗ', ru('инвалид|ограниченными возможностями|\\bОВЗ\\b', 'i')],
  ['Охрана труда', ru('охран\\w*\\s+труда', 'i')],
  ['Контрактная система в сфере закупок', ru('закупок|контрактн\\w*\\s+систем', 'i')],
  ['Гражданская оборона и защита от ЧС', ru('гражданск\\w*\\s+оборон', 'i')],
  ['Информационно-образовательная среда', /информационно-образовательн/i],
];

const YEAR_RE = ru('\\b(20\\d{2})\\b');

/** float() из Python: «16,5» уже приведена к точке, мусор даёт null. */
function pyFloat(s: string): number | null {
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

interface DpoRecord {
  fio: string;
  category: string;
  kind: string;
  group: string;
  theme: string;
  org: string;
  hours: number | null;
  issued: string;
}

export interface DpoStats {
  year: number;
  total_records: number;
  total_people: number;
  multi_program_people: number;
  total_programs: number;
  long_events: number;
  short_events: number;
  kinds: [string, number][];
  categories: [string, number][];
  categories_other: number;
  forms: { internal: number; external: number; internship: number };
  mandatory: [string, number][];
  top_themes: [string, number][];
}

/** Агрегация выгрузки. rows — строки листа, включая шапку. */
export function analyzeDpoRows(rows: string[][]): DpoStats {
  let headerIdx: Map<string, number> | null = null;
  const records: DpoRecord[] = [];
  let currentFio: string | null = null;
  let paramYear: number | null = null;

  for (const row of rows) {
    const cells = row.map((c) => (c ?? '').trim());
    if (!cells.some((c) => c)) continue;
    const low = cells.map((c) => c.toLowerCase());

    if (!headerIdx) {
      // Параметры до шапки: «Период завершения: 31.12.2023» → год отчёта
      const joined = cells.join(' ');
      if (joined.toLowerCase().includes('период')) {
        const m = YEAR_RE.exec(joined);
        if (m) paramYear = Number.parseInt(m[1], 10);
      }
      if (HEADER_MARKERS.some((mk) => low.includes(mk))) {
        headerIdx = new Map();
        low.forEach((name, i) => {
          if (name) headerIdx!.set(name, i);
        });
      }
      continue;
    }

    const col = (name: string): string => {
      const i = headerIdx!.get(name);
      return i !== undefined && i < cells.length ? cells[i] : '';
    };

    // forward-fill ФИО (1С показывает его только в первой строке блока)
    const fio = col('физическое лицо');
    if (fio) currentFio = fio;
    if (!(col('вид образования') || col('тема') || col('категория должности'))) continue;

    const hoursRaw = col('часов').replace(/,/g, '.');
    records.push({
      fio: currentFio || `(без ФИО #${records.length})`,
      category: col('категория должности').toUpperCase(),
      kind: col('вид образования'),
      group: col('группа'),
      theme: col('тема'),
      org: col('учереждение') || col('учреждение'),
      hours: hoursRaw ? pyFloat(hoursRaw) : null,
      issued: col('дата выдачи'),
    });
  }

  if (!records.length) {
    throw new DocValueError(
      'Не удалось разобрать выгрузку: не найдена шапка таблицы ' +
        '(«Физическое лицо», «Категория должности», …)'
    );
  }

  const people = new Map<string, DpoRecord[]>();
  for (const r of records) {
    const list = people.get(r.fio);
    if (list) list.push(r);
    else people.set(r.fio, [r]);
  }

  const longRecs = records.filter((r) => r.hours !== null && r.hours >= SHORT_HOURS);
  const shortRecs = records.filter((r) => r.hours !== null && r.hours < SHORT_HOURS);

  const kindCounts = new Map<string, number>();
  for (const r of longRecs) kindCounts.set(r.kind, (kindCounts.get(r.kind) ?? 0) + 1);
  const kinds: [string, number][] = KIND_LABELS.map(([kind, label]) => [label, kindCounts.get(kind) ?? 0]);

  // Категории — по уникальным людям (категория человека = самая частая у его записей)
  const personCat = new Map<string, string>();
  for (const [fio, recs] of people) {
    personCat.set(fio, mostCommon(recs.map((r) => r.category).filter((c) => c)) ?? '');
  }
  const categories: [string, number][] = CATEGORY_GROUPS.map(([, codes, label]) => [
    label,
    [...personCat.values()].filter((c) => codes.includes(c)).length,
  ]);
  const knownCodes = new Set(CATEGORY_GROUPS.flatMap(([, codes]) => codes));
  const categoriesOther = [...personCat.values()].filter((c) => c && !knownCodes.has(c)).length;

  // Формы обучения — по людям (человек может попасть в несколько форм)
  const peopleIn = (rx: RegExp): number =>
    [...people.values()].filter((recs) => recs.some((r) => rx.test(r.group || ''))).length;
  const forms = {
    internal: peopleIn(/внутривуз/i),
    external: peopleIn(/иные/i),
    internship: peopleIn(/стажиров/i),
  };

  const mandatory: [string, number][] = [];
  for (const [label, rx] of MANDATORY) {
    const n = [...people.values()].filter((recs) => recs.some((r) => rx.test(r.theme || ''))).length;
    if (n) mandatory.push([label, n]);
  }

  const themePeople = new Map<string, Set<string>>();
  for (const r of records) {
    if (!r.theme) continue;
    const set = themePeople.get(r.theme);
    if (set) set.add(r.fio);
    else themePeople.set(r.theme, new Set([r.fio]));
  }
  const topThemes = [...themePeople.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 10);

  let year = paramYear;
  if (!year) {
    const years: number[] = [];
    for (const r of records) {
      const m = YEAR_RE.exec(r.issued || '');
      if (m) years.push(Number.parseInt(m[1], 10));
    }
    year = mostCommon(years) ?? new Date().getFullYear();
  }

  const multi = [...people.values()].filter((recs) => recs.length >= 2).length;
  return {
    year,
    total_records: records.length,
    total_people: people.size,
    multi_program_people: multi,
    total_programs: themePeople.size,
    long_events: longRecs.length,
    short_events: shortRecs.length,
    kinds,
    categories,
    categories_other: categoriesOther,
    forms,
    mandatory,
    top_themes: topThemes.map(([t, p]) => [t, p.size] as [string, number]),
  };
}

/** Текст отчёта по структуре образца «ДПО за 2023». Все числа — из таблицы. */
export function buildReportText(stats: DpoStats): string {
  const y = stats.year;
  const p: string[] = [];
  p.push(`Отчет по ДПО за ${y} год`);
  p.push(
    `1. Дополнительное профессиональное образование работников университета в ${y} году ` +
      'осуществлялось в соответствии с Порядком организации дополнительного профессионального ' +
      'образования и внутриорганизационного обучения работников университета, разделом 8 ' +
      'Коллективного договора ТИУ, разделом 9 Трудового кодекса Российской Федерации и ' +
      'Федеральным законом от 29.12.2012 № 273-ФЗ «Об образовании в Российской Федерации».'
  );
  p.push(
    `В ${y} году было организовано дополнительное профессиональное образование ` +
      `${stats.total_people} работников по ${stats.total_programs} программам обучения ` +
      `(при этом ${stats.multi_program_people} человек — по 2 и более программам).`
  );
  const kindsLines = stats.kinds.map(([label, n]) => `${n} — ${label};`).join('\n');
  p.push(
    `Всего проведено ${stats.long_events} обучающих мероприятий по программам ` +
      `дополнительного профессионального образования (от 16 часов), в том числе:\n${kindsLines}`
  );
  if (stats.short_events) {
    p.push(`Проведено ${stats.short_events} краткосрочных программ (до 16 часов).`);
  }

  let catLines = stats.categories
    .filter(([, n]) => n)
    .map(([label, n]) => `${label} – ${n} человек;`)
    .join('\n');
  if (stats.categories_other) {
    catLines += `\nиные категории – ${stats.categories_other} человек;`;
  }
  p.push(`По категориям должностей обучение проходили:\n${catLines}`);

  const f = stats.forms;
  p.push(
    'При организации повышения квалификации использовались разные формы обучения:\n' +
      `внутривузовское повышение квалификации (по программам ИДДО) – ${f.internal} человек;\n` +
      'курсы повышения квалификации, программы профессиональной переподготовки в других ' +
      `образовательных организациях – ${f.external} человек;\n` +
      `стажировки – ${f.internship} человек.`
  );
  if (stats.mandatory.length) {
    const mand = stats.mandatory.map(([label, n]) => `${label} – ${n} человек;`).join('\n');
    p.push(
      `В ${y} году повышение квалификации работников осуществлялось по программам, ` +
        'входящим в перечень обязательного обучения в соответствии с действующим ' +
        `законодательством, в том числе:\n${mand}`
    );
  }
  if (stats.top_themes.length) {
    const top = stats.top_themes.map(([t, n]) => `«${t.slice(0, 120)}» – ${n} человек;`).join('\n');
    p.push(`Наиболее массовые программы обучения ${y} года:\n${top}`);
  }
  p.push(
    '[Разделы о программах по приоритетным направлениям развития университета, ' +
      'бесплатных онлайн-программах и выполнении плана ВОО заполняются вручную — ' +
      'этих данных нет в выгрузке 1С.]'
  );
  return p.join('\n\n');
}

async function renderDpoDocx(stats: DpoStats, bodyText: string): Promise<string> {
  const blocks = bodyText.split(/\n\s*\n+/);
  const paras: DocxPara[] = [
    { runs: [{ text: blocks[0], bold: true, sizePt: 14 }], align: 'center' },
  ];
  for (const block of blocks.slice(1)) {
    const lines = block.split('\n');
    paras.push({ runs: [{ text: lines[0] }], align: 'justify' });
    for (const extra of lines.slice(1)) {
      paras.push({ runs: extra ? [{ text: extra }] : [], leftIndentPt: 24 });
    }
  }
  return saveGenerated(`dpo_report_${stats.year}_${timestamp()}.docx`, buildDocx(paras));
}

/** Полный цикл: агрегаты → текст → docx → «Мои документы». */
export async function createDpoReport(userId: number, rows: string[][]) {
  const stats = analyzeDpoRows(rows);
  const text = buildReportText(stats);
  const filePath = await renderDpoDocx(stats, text);
  const rec = await prisma.my_documents.create({
    data: {
      user_id: userId,
      title: `Отчёт по ДПО за ${stats.year} год`,
      template_key: 'dpo_report',
      file_path: toDocsPath(filePath),
      progress: 100,
      status: 'ready',
      fields: {
        year: stats.year,
        total_people: stats.total_people,
        long_events: stats.long_events,
      } as Prisma.InputJsonValue,
      is_pii: true, // списки обученных работников — документ не хранится
    },
  });
  return { rec, text, stats };
}
