import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { generateText } from '@/lib/ml/llm';
import { buildDocx, emptyPara, type DocxPara } from './docx';
import { DocValueError, ru, saveGenerated, timestamp } from './common';
import { toDocsPath } from '@/lib/news';
import { toNominative } from './morph';

/**
 * Б6: текст вакансии для job-сайтов из должностной инструкции.
 * Порт services/documents/vacancy.py.
 *
 * Раздел 2 «Основные должностные обязанности» переводится LLM в форму
 * объявления. Зарплата и конкретные условия не выдумываются — их заполняет
 * специалист УРП перед публикацией.
 */

/** Триггер чат-команды «сделай вакансию по инструкции» / «текст для hh». */
export const VACANCY_REQUEST_RE = ru(
  '(ваканси|объявлени\\w+\\s+(?:на|о)\\s+(?:работу|должность)|' +
    'текст\\s+для\\s+(?:hh|джоб|job|хедхантер))',
  'i'
);

// Раздел 2 ДИ: «2 ОСНОВНЫЕ ДОЛЖНОСТНЫЕ ОБЯЗАННОСТИ (ТРУДОВАЯ ФУНКЦИЯ)» /
// «2. Должностные обязанности» / «II. Трудовые функции»
const SECTION2_RE = ru(
  '(?:^|\\n)\\s*(?:2|II)[\\s.)-]+[^\\n]*(?:обязанност|трудов\\w+\\s+функци)[^\\n]*\\n',
  'i'
);
const NEXT_SECTION_RE = ru(
  '(?:^|\\n)\\s*(?:3|III)[\\s.)-]+[^\\n]{0,80}(?:прав|ответственност|взаимоотношени|связи)',
  'ig'
);
const POSITION_RE = ru('должностн\\w+\\s+инструкци\\w+\\s*\\n?\\s*([^\\n]{3,90})', 'i');

export const SYSTEM_PROMPT_VACANCY =
  'Ты — HR-специалист Тюменского индустриального университета (ТИУ), готовишь текст ' +
  'вакансии для публикации на job-сайтах (hh.ru и т.п.).\n' +
  'Тебе дают должность и раздел «Должностные обязанности» из должностной инструкции.\n' +
  'Правила:\n' +
  '1. Пиши живым, уважительным языком без канцелярита; убирай номера пунктов (2.1, 2.2), ' +
  'дублирование и общие формальности («соблюдает правила внутреннего распорядка», ' +
  '«выполняет иные поручения» — не включай).\n' +
  '2. Структура строго:\n' +
  'Чем предстоит заниматься:\n- 6–10 ёмких пунктов по содержанию обязанностей\n\n' +
  'Что мы ожидаем:\n- 4–6 требований, АККУРАТНО выведенных из обязанностей ' +
  '(навыки, инструменты, качества); ничего не выдумывай сверх текста\n\n' +
  'Условия:\n- работа в крупнейшем техническом университете Тюменской области\n' +
  '- официальное трудоустройство по ТК РФ, стабильные выплаты\n' +
  '- социальная программа университета (льготы, поддержка сотрудников)\n' +
  '3. НЕ указывай зарплату, график и адрес — их добавит специалист УРП.\n' +
  '4. Не используй markdown-заголовки (#), только строки с двоеточием и дефисные списки.\n' +
  'Верни только текст объявления.';

/** Название должности из шапки «Должностная инструкция <должности>». */
export async function extractPosition(diText: string): Promise<string | null> {
  const m = POSITION_RE.exec(diText || '');
  if (!m) return null;
  // strip(" .;:—-") — снимаем эти символы с обоих концов.
  let pos = m[1].replace(/^[ .;:—-]+/, '').replace(/[ .;:—-]+$/, '');
  if (!pos) return null;
  pos = await toNominative(pos);
  return pos.slice(0, 1).toUpperCase() + pos.slice(1);
}

/** Раздел 2 «Должностные обязанности» ДИ (до раздела 3). null — не найден. */
export function extractDutiesSection(diText: string): string | null {
  const text = diText || '';
  const m = SECTION2_RE.exec(text);
  if (!m) return null;
  const start = m.index;
  // re.search(rx, text, pos) — ищем следующий раздел ПОСЛЕ конца заголовка.
  NEXT_SECTION_RE.lastIndex = m.index + m[0].length;
  const m2 = NEXT_SECTION_RE.exec(text);
  const section = text.slice(start, m2 ? m2.index : text.length).trim();
  return section.length >= 200 ? section : null;
}

async function generateVacancyText(
  duties: string,
  position: string | null,
  userId: number | null
): Promise<string> {
  const userMsg =
    `Должность: ${position || 'не указана (возьми из текста раздела)'}\n\n` +
    `Раздел «Должностные обязанности» из должностной инструкции:\n${duties.slice(0, 6000)}`;
  const text = (
    await generateText({
      system: SYSTEM_PROMPT_VACANCY,
      user: userMsg,
      maxTokens: 1200,
      temperature: 0.4,
      userId,
    })
  ).trim();
  if (!text) throw new Error('LLM не вернула текст вакансии');
  return text;
}

async function renderVacancyDocx(position: string | null, bodyText: string): Promise<string> {
  const paras: DocxPara[] = [
    {
      runs: [{ text: position ? `Вакансия: ${position}` : 'Текст вакансии', bold: true, sizePt: 14 }],
      align: 'center',
    },
    emptyPara(),
  ];
  for (const raw of bodyText.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) {
      paras.push(emptyPara());
      continue;
    }
    const bullet = line.startsWith('-') || line.startsWith('–') || line.startsWith('•');
    paras.push({ runs: [{ text: line }], ...(bullet ? { leftIndentPt: 18 } : {}) });
  }
  paras.push({
    runs: [
      {
        text: 'Зарплата, график работы и контакты добавляются специалистом УРП перед публикацией.',
        italic: true,
        sizePt: 10,
      },
    ],
  });
  return saveGenerated(`vacancy_${timestamp()}.docx`, buildDocx(paras));
}

/** Полный цикл: текст ДИ → раздел 2 → LLM-текст вакансии → docx → «Мои документы». */
export async function createVacancy(userId: number, diText: string) {
  const pos = await extractPosition(diText);
  let duties = extractDutiesSection(diText);
  const meta = { position: pos, section_found: Boolean(duties) };
  if (!duties) {
    // Раздел не распознан — отдаём LLM весь текст ДИ (обязанности она выделит сама)
    duties = (diText || '').slice(0, 6000);
    if (duties.trim().length < 200) {
      throw new DocValueError('В файле не нашлось текста должностной инструкции');
    }
  }
  const text = await generateVacancyText(duties, pos, userId);
  const filePath = await renderVacancyDocx(pos, text);
  const rec = await prisma.my_documents.create({
    data: {
      user_id: userId,
      title: pos ? `Вакансия: ${pos}` : 'Текст вакансии',
      template_key: 'vacancy',
      file_path: toDocsPath(filePath),
      progress: 100,
      status: 'ready',
      fields: meta as Prisma.InputJsonValue,
      is_pii: false, // значение по умолчанию модели MyDocuments
    },
  });
  return { rec, text, meta };
}
