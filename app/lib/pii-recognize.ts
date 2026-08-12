import 'server-only';
import { generateText } from './ml/llm';
import { BAD_DATE, parseBirthDate } from './pii';

// Распознавание ФИО и даты рождения из текста документа — порт
// backend/services/pii/recognize.py. Сначала regex по типичным шаблонам,
// затем LLM: её ответ приоритетнее, regex остаётся запасным вариантом.
//
// Модуль лежит рядом с lib/pii.ts, а не внутри него: pii.ts — это файл, каталог
// lib/pii/ создать нельзя без переименования, а тянуть LLM в общий модуль ПДн
// (его импортируют все роуты) не нужно.
//
// В Python `\b` знает кириллицу, в JS — только ASCII, поэтому границу слова
// подставляем явно (тот же приём, что в lib/pii.ts и lib/parsers).

const W = '0-9A-Za-zА-Яа-яЁё_';
const B = `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`;

function ru(pattern: string, flags = ''): RegExp {
  return new RegExp(pattern.replace(/\\b/g, B), flags);
}

const SYSTEM_PROMPT_PII_RECOGNIZE =
  'Вы извлекаете персональные данные сотрудника из HR-документа на русском. ' +
  'Верните строго JSON: ' +
  '{"surname":"...", "name":"...", "patronymic":"..."|null, ' +
  '"birth_date":"DD.MM.YYYY"|null}. ' +
  'Если каких-то полей нет — null. Никакого текста вне JSON.';

const DATE_RE = ru('\\b(\\d{2})\\.(\\d{2})\\.(\\d{4})\\b');
const FIO_RE = ru('\\b([А-ЯЁ][а-яё]+)\\s+([А-ЯЁ][а-яё]+)(?:\\s+([А-ЯЁ][а-яё]+))?\\b');

// Контекстные маркеры даты рождения: проверяются по порядку, срабатывает первый.
const BIRTH_MARKERS = [
  /дата\s+рождения[:\s]+(\d{2})\.(\d{2})\.(\d{4})/i,
  /родил[аи]сь[:\s]+(\d{2})\.(\d{2})\.(\d{4})/i,
  /г\.р\.\s*(\d{2})\.(\d{2})\.(\d{4})/i,
];

/** date(y, m, d) в Python: несуществующая дата — ValueError, здесь null. */
function makeDate(dd: string, mm: string, yyyy: string): Date | null {
  const parsed = parseBirthDate(`${dd}.${mm}.${yyyy}`);
  return parsed === BAD_DATE ? null : parsed;
}

interface PreParsed {
  surname?: string;
  name?: string;
  patronymic?: string | null;
  birth_date?: Date;
}

/** Лёгкая попытка вытащить очевидное regex'ом (_quick_pre_parse). */
function quickPreParse(text: string): PreParsed {
  const out: PreParsed = {};
  const fio = FIO_RE.exec(text);
  if (fio) {
    out.surname = fio[1];
    out.name = fio[2];
    out.patronymic = fio[3] ?? null; // group(3) без совпадения — None
  }
  // Первый сработавший маркер прекращает поиск, даже если дата в нём битая.
  for (const rx of BIRTH_MARKERS) {
    const m = rx.exec(text);
    if (m) {
      const d = makeDate(m[1], m[2], m[3]);
      if (d) out.birth_date = d;
      break;
    }
  }
  return out;
}

/** Python `a or b`: пустая строка и None уходят к запасному значению. */
function orElse(a: unknown, b: unknown): unknown {
  return a ? a : b;
}

/** `_clean`: пустое значение — null, иначе строка без пробелов по краям. */
function clean(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  return s || null;
}

export interface RecognizedPerson {
  surname: string | null;
  name: string | null;
  patronymic: string | null;
  birth_date: Date | null;
}

/**
 * Порт recognize_person. Любое поле может быть null — UI даёт исправить.
 * Сбой LLM (недоступна, переполнена очередь, мусор вместо JSON) не ошибка:
 * остаётся результат regex-эвристики.
 */
export async function recognizePerson(text: string): Promise<RecognizedPerson> {
  if (!text || !text.trim()) {
    return { surname: null, name: null, patronymic: null, birth_date: null };
  }

  const pre = quickPreParse(text.slice(0, 4000));

  let data: Record<string, unknown> = {};
  try {
    const raw = await generateText({
      system: SYSTEM_PROMPT_PII_RECOGNIZE,
      user: text.slice(0, 3500), // для LLM не нужен полный текст
      maxTokens: 160,
      temperature: 0.0,
    });
    // Модель любит обрамлять JSON пояснениями — берём первый объект в ответе.
    const m = /\{.*?\}/s.exec(raw);
    data = m ? (JSON.parse(m[0]) as Record<string, unknown>) : {};
  } catch {
    // В Python здесь logger.warning; своего логгера у фронтенда нет.
    data = {};
  }

  const surname = orElse(data.surname, pre.surname);
  const name = orElse(data.name, pre.name);
  const patronymic = orElse(data.patronymic, pre.patronymic);

  let bd: Date | null = pre.birth_date ?? null;
  const rawBd = typeof data.birth_date === 'string' ? data.birth_date.trim() : '';
  if (!bd && rawBd) {
    const m = DATE_RE.exec(rawBd);
    bd = m ? makeDate(m[1], m[2], m[3]) : null;
  }

  return {
    surname: clean(surname),
    name: clean(name),
    patronymic: clean(patronymic),
    birth_date: bd,
  };
}
