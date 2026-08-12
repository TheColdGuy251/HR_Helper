import 'server-only';
import { cosine, RAG } from './config';
import { embed, embedOne } from './embeddings';
import { generateJson } from './llm-json';
import type { ChatMessage } from './llm';
import { SYSTEM_PROMPT_INTENT_ROUTER } from './prompts';

// Контекстное определение намерения запроса + semantic-router планировщика.
// Порт services/rag/intent_classifier.py и services/rag/intent_router.py
// (в Python это два файла, здесь один — они делят приём «прототипы + косинус»).
//
// Двухуровневая схема классификатора:
// 1. СЕМАНТИЧЕСКИЙ уровень (всегда): эмбеддинг запроса против прототипов
//    четырёх классов. Ловит перефразировки без единого триггер-слова.
// 2. LLM-уровень (только пограничные случаи, когда топ-2 класса близки):
//    модель классифицирует запрос с учётом последних реплик диалога.
//
// resolveIntent() возвращает класс или null («не уверен» / LLM недоступна) —
// вызывающий код тогда откатывается к регэксп-гейтам, поэтому классификатор
// только РАСШИРЯЕТ распознавание, не сужая его.

export type Intent = 'smalltalk' | 'doc_generate' | 'kb_question' | 'meta_chat';

const INTENT_EXAMPLES: Record<Intent, string[]> = {
  smalltalk: [
    'привет', 'привет!', 'здравствуйте', 'добрый день', 'доброе утро',
    'спасибо большое', 'спасибо, понял', 'благодарю за помощь', 'пока',
    'до свидания', 'как дела?', 'чё как?', 'кто ты?', 'ты кто такой?',
    'это кто?', 'ты бот или человек?', 'что ты умеешь?', 'чем можешь помочь?',
    'как тебя зовут?', 'ахаха, смешно', 'ок, понятно', 'круто!', 'ну ты даёшь',
  ],
  doc_generate: [
    'оформи приказ об отпуске на Иванову', 'сделай заявление на отпуск',
    'подготовь приказ о приёме на работу', 'сформируй справку на работника',
    'создай документ об увольнении Петрова', 'нанять лаборанта Сидорову',
    'оформи отпуск по беременности и родам на Смирнову',
    'нужно заявление о переносе отпуска', 'сделай служебную записку',
    'выдай бланк заявления на увольнение', 'набросай приказ на отпуск',
    'заполни заявление на увольнение по собственному',
    'мне нужен документ о назначении материально ответственного лица',
    'напиши заявление о выходе из отпуска',
    'привет! оформи приказ об отпуске на Иванову',
  ],
  kb_question: [
    'как оформить отпуск?', 'что говорит статья 81 трудового кодекса?',
    'какие документы нужны при приёме на работу?',
    'сколько дней отпуска положено в год?', 'как проходит аттестация?',
    'можно ли уволить сотрудника на больничном?',
    'что такое сверхурочная работа', 'как оплачивается работа в выходной день',
    'какой порядок увольнения по собственному желанию',
    'где найти положение о наградах', 'кто может получить грант',
    'какая периодичность медосмотра', 'что положено молодым НПР',
    'хочу взять пару дней за свой счёт, что мне делать?',
    'какие гарантии у беременных сотрудниц',
    'работник опаздывает, какое взыскание можно применить?',
    'сотрудник не вышел на работу, что делать?',
    'что положено сотруднице, уходящей в декрет?',
    // Смешанные сообщения: приветствие + содержательный вопрос → это ВОПРОС.
    'привет! подскажи, что говорит статья 70 трудового кодекса',
    'здравствуйте, можно текст статьи 81?',
    'привет, перечисли основания для увольнения',
    'добрый день! как оформить отпуск за свой счёт?',
  ],
  meta_chat: [
    'о чём мы говорили?', 'что происходило в чате?',
    'перескажи нашу переписку', 'подведи итог разговора',
    'что обсуждали выше?', 'о чём этот диалог?', 'напомни, о чём шла речь',
    'сделай краткое содержание беседы',
  ],
};

const VALID_INTENTS = new Set<string>(Object.keys(INTENT_EXAMPLES));

// Референсные слова («её», «это», «продолжи»): короткий запрос с ними понятен
// только из истории; семантике доверять нельзя — сразу пограничный случай.
const REFERENTIAL_SHORT_RE =
  /(?<![0-9A-Za-zА-Яа-яЁё_])(её|ее|его|их|это|этой|этого|тот|ту|та|там|выше|дальше|продолж|ещё|еще)(?![0-9A-Za-zА-Яа-яЁё_])/i;

// Прототипы живут в памяти процесса; globalThis — чтобы hot-reload в dev не
// пересчитывал их при каждом изменении файла.
const g = globalThis as unknown as {
  __hrIntentVecs?: Promise<Record<Intent, number[][]>>;
  __hrRouterVecs?: Promise<{ structural: number[][]; semantic: number[][] }>;
};

function intentVecs(): Promise<Record<Intent, number[][]>> {
  if (!g.__hrIntentVecs) {
    g.__hrIntentVecs = (async () => {
      const entries = Object.entries(INTENT_EXAMPLES) as [Intent, string[]][];
      const out = {} as Record<Intent, number[][]>;
      for (const [intent, examples] of entries) {
        // Нижний регистр перед эмбеддингом: энкодер регистро-ЗАВИСИМ, и без
        // нормализации «Как дела?» и «как дела?» дают разные векторы — у
        // порога/маржи это переворачивает вердикт. Запрос нормализуем так же.
        out[intent] = await embed(examples.map((e) => e.toLowerCase()), true);
      }
      return out;
    })().catch((e) => {
      g.__hrIntentVecs = undefined; // не кэшируем сбой прогрева
      throw e;
    });
  }
  return g.__hrIntentVecs;
}

/** Максимальная близость запроса к примерам каждого класса. */
async function semanticScores(query: string): Promise<Record<Intent, number>> {
  const vecs = await intentVecs();
  const qv = await embedOne((query || '').toLowerCase(), true);
  const out = {} as Record<Intent, number>;
  for (const [intent, list] of Object.entries(vecs) as [Intent, number[][]][]) {
    out[intent] = list.reduce((best, v) => Math.max(best, cosine(qv, v)), 0);
  }
  return out;
}

/** Уверенный семантический вердикт или null (плюс score и отрыв от второго). */
export async function classifyFast(
  query: string
): Promise<{ intent: Intent | null; score: number; margin: number }> {
  const scores = await semanticScores(query);
  const ranked = (Object.entries(scores) as [Intent, number][]).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;
  const margin = topScore - secondScore;
  if (topScore >= RAG.intentSemanticThreshold && margin >= RAG.intentSemanticMargin) {
    return { intent: top, score: topScore, margin };
  }
  return { intent: null, score: topScore, margin };
}

/** Пограничный случай → классификация моделью с учётом истории диалога. */
async function classifyLlm(query: string, history?: ChatMessage[] | null): Promise<Intent | null> {
  let userMsg = query;
  if (history?.length) {
    const recent = history
      .slice(-4)
      .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${(m.content || '').slice(0, 200)}`);
    userMsg = `Последние реплики диалога:\n${recent.join('\n')}\n\nТекущий запрос: ${query}`;
  }
  let data: Record<string, unknown> | null;
  try {
    data = await generateJson(
      SYSTEM_PROMPT_INTENT_ROUTER,
      userMsg,
      '{"intent": "smalltalk|doc_generate|kb_question|meta_chat"}',
      60
    );
  } catch {
    return null;
  }
  if (!data) return null;
  const intent = String(data.intent ?? '').trim().toLowerCase();
  return VALID_INTENTS.has(intent) ? (intent as Intent) : null;
}

/**
 * Намерение запроса по КОНТЕКСТУ. null — «не уверен» (вызывающий код
 * откатывается к регэксп-гейтам). Ошибки не роняют обработку сообщения.
 */
export async function resolveIntent(
  query: string,
  history?: ChatMessage[] | null
): Promise<Intent | null> {
  const q = (query || '').trim();
  if (!q) return null;
  try {
    // Короткий референсный запрос («а её продолжи») без истории не понять —
    // семантике не доверяем, отдаём решение LLM (или фолбэку).
    const referential = q.length < 30 && REFERENTIAL_SHORT_RE.test(q);
    if (!referential) {
      const { intent } = await classifyFast(q);
      if (intent !== null) return intent;
    }
    if (RAG.intentUseLlm) return await classifyLlm(q, history);
  } catch {
    /* сбой классификатора — фолбэк на регэкспы */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Semantic-router (порт services/rag/intent_router.py)
// ---------------------------------------------------------------------------
// Регэксп needsPlanner ловит структурные запросы по триггер-словам. Роутер
// добирает перефразировки БЕЗ таких слов, сравнивая эмбеддинг запроса с
// примерами «структурных» и «семантических» намерений. Используется как
// ИЛИ-сигнал к регэкспу — полноту он никогда не снижает.

const STRUCTURAL_EXAMPLES = [
  'статья 81',
  'процитируй статью 192',
  'что написано в статье 84.1',
  'последняя статья кодекса',
  'самая первая статья',
  'финальная норма документа',
  'первые три статьи',
  'последние пять статей',
  'покажи две начальные статьи',
  'сравни статью 80 и 81',
  'чем отличается перевод от перемещения',
  'процитируй её целиком',
  'покажи её полностью',
];
const SEMANTIC_EXAMPLES = [
  'как оформить отпуск работнику',
  'что делать при простое предприятия',
  'как оплачивается работа в выходной день',
  'порядок увольнения по собственному желанию',
  'какие гарантии у беременных сотрудниц',
  'что такое сверхурочная работа',
  'как рассчитать компенсацию за неиспользованный отпуск',
  'обязан ли работодатель индексировать зарплату',
];

function routerVecs() {
  if (!g.__hrRouterVecs) {
    g.__hrRouterVecs = (async () => ({
      structural: await embed(STRUCTURAL_EXAMPLES, true),
      semantic: await embed(SEMANTIC_EXAMPLES, true),
    }))().catch((e) => {
      g.__hrRouterVecs = undefined;
      throw e;
    });
  }
  return g.__hrRouterVecs;
}

/** (макс. близость к структурным, макс. близость к семантическим). */
export async function routerScores(query: string): Promise<[number, number]> {
  const { structural, semantic } = await routerVecs();
  const qv = await embedOne(query, true);
  const s = structural.reduce((best, v) => Math.max(best, cosine(qv, v)), 0);
  const m = semantic.reduce((best, v) => Math.max(best, cosine(qv, v)), 0);
  return [s, m];
}

/**
 * True, если запрос ближе к структурным примерам, чем к семантическим, и
 * превышает порог уверенности. На ошибке — false (откат к регэксп-гейту).
 */
export async function isStructural(query: string, threshold?: number): Promise<boolean> {
  const q = (query || '').trim();
  if (!q) return false;
  const limit = threshold ?? RAG.routerThreshold;
  try {
    const [s, m] = await routerScores(q);
    return s >= limit && s > m;
  } catch {
    return false;
  }
}
