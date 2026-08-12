import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { cut, toDocsPath } from '@/lib/news';
import { generateText } from '@/lib/ml/llm';
import { generateJsonOrMock } from '@/lib/ml/llm-json';
import { SYSTEM_PROMPT_CHARACTERISTIC, SYSTEM_PROMPT_PETITION_EXTRACT } from '@/lib/ml/prompts';
import { buildDocx, emptyPara, type DocxPara } from './docx';
import { ru, saveGenerated, timestamp } from './common';

/**
 * Б1: характеристика для представления работника к внешней награде — из
 * ходатайства 1С:Документооборот. Порт services/documents/characteristic.py.
 *
 * ПДн: текст ходатайства обрабатывается эфемерно и НЕ попадает в базу знаний.
 */

/** Триггер чат-команды «сделай характеристику» (при вложенном ходатайстве). */
export const CHARACTERISTIC_REQUEST_RE = ru('характеристик\\w*', 'i');

// Роли ППС — для них свой стиль характеристики (наука/преподавание).
const PPS_RE = ru(
  'профессор|доцент|преподават|ассистент|заведующ\\w*\\s+кафедр|научн\\w*\\s+сотрудник',
  'i'
);

export const FIELD_KEYS = [
  'award', 'basis', 'fio', 'position', 'department',
  'degree', 'rank', 'career', 'awards', 'achievements',
] as const;

export type PetitionFields = Record<string, string | string[] | null>;

// Regex-подстраховка по стабильной печатной форме (на случай недоступной LLM).
const AWARD_RE = /Награда\s*[:：]?\s*(.+)/i;
const BASIS_RE = /Основание\s*[:：]?\s*(.+)/i;
const FIO_ROW_RE =
  /Фамилия,?\s*имя,?\s*отчество\s*[:：|]?\s*([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2})/;

/** 'pps' — преподавательские должности, 'aup' — административные/специалисты. */
export function detectCategory(position: unknown): string {
  return typeof position === 'string' && position && PPS_RE.test(position) ? 'pps' : 'aup';
}

/** str.strip(chars) — снимает символы набора с обоих концов. */
function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a += 1;
  while (b > a && chars.includes(s[b - 1])) b -= 1;
  return s.slice(a, b);
}

function quickParse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, rx] of [['award', AWARD_RE], ['basis', BASIS_RE], ['fio', FIO_ROW_RE]] as const) {
    const m = rx.exec(text);
    if (m) out[key] = stripChars(m[1].trim(), '|').trim();
  }
  return out;
}

/**
 * Извлекает поля ходатайства: LLM (основной путь) + regex-подстраховка.
 * Любое поле может быть null/[] — UI даёт пользователю поправить руками.
 */
export async function parsePetition(text: string, userId: number | null = null): Promise<PetitionFields> {
  const fields: PetitionFields = {};
  for (const k of FIELD_KEYS) fields[k] = null;
  fields.career = [];
  fields.awards = [];

  const sample = cut(text || '', 8000);
  try {
    const data = await generateJsonOrMock(
      SYSTEM_PROMPT_PETITION_EXTRACT,
      sample,
      '{"award": "...", "basis": "...", "fio": "...", "position": "...", ' +
        '"department": "...", "degree": null, "rank": null, ' +
        '"career": [], "awards": [], "achievements": "..."}',
      userId
    );
    if (!data._mock) {
      for (const k of FIELD_KEYS) {
        const v = data[k];
        if (k === 'career' || k === 'awards') {
          fields[k] = Array.isArray(v)
            ? v.map((x) => String(x).trim()).filter((x) => x)
            : [];
        } else if (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null') {
          fields[k] = v.trim();
        }
      }
    }
  } catch {
    /* [CHAR] LLM-извлечение ходатайства не удалось — остаётся regex-подстраховка */
  }

  for (const [k, v] of Object.entries(quickParse(sample))) fields[k] = fields[k] || v;
  fields.category = detectCategory(fields.position);
  return fields;
}

/** Данные ходатайства в читаемом виде для промпта генерации. */
function fieldsBlock(fields: PetitionFields): string {
  const lines = ['Данные из ходатайства о награждении:'];
  const labels: [string, string][] = [
    ['award', 'Награда'], ['basis', 'Основание'], ['fio', 'ФИО'],
    ['position', 'Должность'], ['department', 'Подразделение'],
    ['degree', 'Учёная степень'], ['rank', 'Учёное звание'],
  ];
  for (const [k, label] of labels) {
    if (fields[k]) lines.push(`${label}: ${fields[k]}`);
  }
  const career = fields.career;
  if (Array.isArray(career) && career.length) {
    lines.push('Трудовая деятельность в ТИУ:');
    lines.push(...career.map((c) => `- ${c}`));
  }
  const awards = fields.awards;
  if (Array.isArray(awards) && awards.length) {
    lines.push('Награды и поощрения за последние 5 лет:');
    lines.push(...awards.map((a) => `- ${a}`));
  }
  if (fields.achievements) {
    lines.push(`Конкретные результаты работы и основные достижения:\n${fields.achievements}`);
  }
  return lines.join('\n');
}

const STYLE_HINTS: Record<string, string> = {
  pps:
    'Категория работника: профессорско-преподавательский состав. Акценты стиля: научная и ' +
    'научно-педагогическая работа, публикации/монографии (если указаны), подготовка ' +
    'обучающихся, участие в советах/комиссиях, вклад в развитие направления.',
  aup:
    'Категория работника: административно-управленческий персонал / специалист. Акценты ' +
    'стиля: карьерный путь («прошёл(шла) путь от … до …»), организация и результаты работы ' +
    'подразделения, участие в проектах/проверках/аккредитациях, деловые качества.',
};

/** Связный текст характеристики по данным ходатайства (LLM, без выдумывания). */
export async function generateCharacteristicText(
  fields: PetitionFields,
  category: string | null,
  userId: number | null
): Promise<string> {
  const cat = category || (fields.category as string) || detectCategory(fields.position);
  const userMsg = (STYLE_HINTS[cat] ?? STYLE_HINTS.aup) + '\n\n' + fieldsBlock(fields);
  const text = (
    await generateText({
      system: SYSTEM_PROMPT_CHARACTERISTIC,
      user: userMsg,
      maxTokens: 1400,
      temperature: 0.3,
      userId,
    })
  ).trim();
  if (!text) throw new Error('LLM не вернула текст характеристики');
  return text;
}

const SLUG_RE = ru('[^\\w]+', 'g');

/** Собирает .docx: шапка «ХАРАКТЕРИСТИКА» + ФИО/должность + абзацы текста. */
async function renderCharacteristicDocx(fields: PetitionFields, bodyText: string): Promise<string> {
  const paras: DocxPara[] = [
    { runs: [{ text: 'ХАРАКТЕРИСТИКА', bold: true, sizePt: 14 }], align: 'center' },
  ];

  const subBits = [fields.fio, fields.position, fields.department].filter((b) => b) as string[];
  if (subBits.length) {
    paras.push({ runs: [{ text: subBits.join(', '), bold: true }], align: 'center' });
  }
  if (fields.award) {
    paras.push({
      runs: [{ text: `(для представления к награде: ${fields.award})`, italic: true }],
      align: 'center',
    });
  }
  paras.push(emptyPara());

  for (const para of bodyText.split(/\n\s*\n+/)) {
    paras.push({
      runs: [{ text: para.trim() }],
      align: 'justify',
      firstLineIndentPt: 28,
    });
  }

  const fioSlug = String(fields.fio || 'работник').replace(SLUG_RE, '_').slice(0, 40);
  return saveGenerated(`characteristic_${fioSlug}_${timestamp()}.docx`, buildDocx(paras));
}

/** Полный цикл: текст → docx → запись в «Мои документы». */
export async function createCharacteristic(
  userId: number,
  fields: PetitionFields,
  category: string | null
) {
  const text = await generateCharacteristicText(fields, category, userId);
  const filePath = await renderCharacteristicDocx(fields, text);
  let title = 'Характеристика';
  if (fields.fio) title += ` — ${fields.fio}`;

  const stored: Record<string, unknown> = {};
  for (const k of [...FIELD_KEYS, 'category']) stored[k] = fields[k] ?? null;

  const rec = await prisma.my_documents.create({
    data: {
      user_id: userId,
      title,
      template_key: 'characteristic',
      file_path: toDocsPath(filePath),
      progress: 100,
      status: 'ready',
      fields: stored as Prisma.InputJsonValue,
      is_pii: true, // ПДн работника — документ не хранится (автоудаление)
    },
  });
  return { rec, text };
}

/** Нормализует поля из запроса клиента (модалка может прислать правки). */
export function petitionFieldsFromJson(raw: unknown): PetitionFields {
  let data: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    data = raw as Record<string, unknown>;
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw || '{}');
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
    } catch {
      /* json.loads бросил бы — здесь считаем поля пустыми */
    }
  }

  const fields: PetitionFields = {};
  for (const k of FIELD_KEYS) fields[k] = null;
  fields.career = [];
  fields.awards = [];

  for (const k of FIELD_KEYS) {
    const v = data[k];
    if (k === 'career' || k === 'awards') {
      if (Array.isArray(v)) fields[k] = v.map((x) => String(x).trim()).filter((x) => x);
      // Модалка шлёт многострочный textarea — режем по строкам.
      else if (typeof v === 'string') fields[k] = v.split(/\r\n|\r|\n/).map((s) => s.trim()).filter((s) => s);
    } else if (typeof v === 'string' && v.trim()) {
      fields[k] = v.trim();
    }
  }
  fields.category = (typeof data.category === 'string' && data.category) || detectCategory(fields.position);
  return fields;
}
