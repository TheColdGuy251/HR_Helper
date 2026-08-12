import 'server-only';
import { initStemmer, morphologyMode } from './bm25';

// Коррекция опечаток в запросе — для РОУТИНГА и ПОИСКА, не для показа.
// Порт services/rag/spellfix.py.
//
// Регэксп-гейты (smalltalk, doc-intent, планировщик) и BM25 не переживают
// опечаток: «пиривет» не распознаётся как приветствие, «преказ» не триггерит
// генерацию документа, «дкумент» не находится поиском. Здесь — дешёвый
// детерминированный слой:
//
// 1. слово, ИЗВЕСТНОЕ морфологии, не трогаем — правим только опечатки;
// 2. неизвестное сравниваем со словарём триггеров/HR-терминов по расстоянию
//    Дамерау-Левенштейна (≤1 для коротких слов, ≤2 для длинных);
// 3. при совпадении подставляем словарную основу — регэкспы и лемматизация
//    BM25 работают по основам, потеря окончания не мешает.
//
// Исходный текст пользователя НЕ меняется: правленая строка живёт только
// внутри пайплайна; модель видит оригинал и сама устойчива к опечаткам.
//
// ОТЛИЧИЕ ОТ PYTHON: «известность» слова там даёт pymorphy3.word_is_known(),
// здесь — словарный разбор Az.js (тот же корпус OpenCorpora): слово считается
// известным, если хотя бы один разбор пришёл от парсера Dictionary без правок.

const LEXICON: string[] = [
  // приветствия / вежливость (гейт smalltalk)
  'привет', 'здравствуйте', 'здравствуй', 'спасибо', 'благодарю', 'пожалуйста',
  'пока', 'свидания', 'доброе', 'добрый', 'утро', 'вечер',
  // команды генерации документов
  'приказ', 'документ', 'заявление', 'справка', 'шаблон', 'бланк', 'записка',
  'служебная', 'оформи', 'оформить', 'сформируй', 'сформировать', 'создай',
  'создать', 'сделай', 'сделать', 'подготовь', 'подготовить', 'сгенерируй',
  'нанять', 'принять', 'уволить',
  // частотные HR-термины (retrieval/BM25)
  'отпуск', 'увольнение', 'зарплата', 'оклад', 'премия', 'аттестация',
  'командировка', 'договор', 'декрет', 'больничный', 'стажировка', 'обучение',
  'награда', 'характеристика', 'вакансия', 'статья', 'кодекс', 'трудовой',
  'сотрудник', 'работник', 'инструкция', 'охрана', 'труда', 'выходной',
  'прогул', 'испытательный', 'совместительство', 'переработка', 'сокращение',
  'медосмотр', 'выплата', 'компенсация', 'пособие', 'беременность',
  // вопросительные слова (гейты информационного запроса)
  'сколько', 'когда', 'почему', 'зачем', 'какой', 'какие', 'расскажи',
  'объясни', 'подскажи', 'покажи',
];

const LEXICON_SET = new Set(LEXICON);
const TOKEN_RE = /[а-яёА-ЯЁ]+/g;

type MorphParse = { parser?: string; typosCnt?: number; stutterCnt?: number };
type MorphFn = (word: string) => MorphParse[];

let morph: MorphFn | null = null;
let morphReady = false;

/**
 * Готовит морфологию. Az.js инициализируется тем же вызовом, что и для BM25 —
 * словари (~10 МБ) грузятся один раз на процесс.
 */
async function ensureMorph(): Promise<void> {
  if (morphReady) return;
  morphReady = true;
  try {
    await initStemmer();
    if (morphologyMode() !== 'lemmatization') return; // Az не поднялся — правим без проверки
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    morph = (require('az') as { Morph: MorphFn }).Morph;
  } catch {
    morph = null;
  }
}

/** Слово есть в словаре морфологии (а не «угадано» предсказателем). */
function wordIsKnown(word: string): boolean {
  if (!morph) return false;
  try {
    return morph(word).some((p) => p.parser === 'Dictionary' && !p.typosCnt && !p.stutterCnt);
  } catch {
    return false;
  }
}

/** Расстояние Дамерау-Левенштейна (с транспозицией) с ранним выходом > limit. */
function dlDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev2: number[] | null = null;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

function limitFor(length: number): number {
  return length <= 5 ? 1 : 2;
}

// Слова повторяются — кэш экономит перебор словаря на каждом токене.
const wordCache = new Map<string, string>();

function correctWord(word: string): string {
  const cached = wordCache.get(word);
  if (cached !== undefined) return cached;

  let result = word;
  if (word.length >= 4 && !LEXICON_SET.has(word) && !wordIsKnown(word)) {
    const limit = limitFor(word.length);
    let best: string | null = null;
    let bestD = limit + 1;
    for (const lex of LEXICON) {
      // Сравниваем и целиком, и по длине словарного слова (+1): опечатка часто
      // в основе, а хвост-окончание («преказом» → «приказ») дистанцию не раздувает.
      const d = Math.min(
        dlDistance(word, lex, limit),
        dlDistance(word.slice(0, lex.length + 1), lex, limit)
      );
      if (d < bestD) {
        best = lex;
        bestD = d;
        if (d === 0) break;
      }
    }
    if (best !== null && bestD <= limit) result = best;
  }

  if (wordCache.size < 50_000) wordCache.set(word, result);
  return result;
}

/**
 * Правит опечатки в неизвестных словах по словарю триггеров.
 * «пиривет» → «привет», «преказ» → «приказ», «дкумент» → «документ».
 * Корректные слова и незнакомые словарю (фамилии и т.п.) остаются как есть.
 */
export async function correctTypos(text: string): Promise<string> {
  if (!text) return text;
  await ensureMorph();
  return text.replace(TOKEN_RE, (w) => {
    const fixed = correctWord(w.toLowerCase());
    return fixed === w.toLowerCase() ? w : fixed;
  });
}
