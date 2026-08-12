import 'server-only';
import { prisma } from '@/lib/db';
import {
  classifyTopics,
  isCompareQuery,
  maybeDecompose,
  maybeHyde,
  maybeRewriteQuery,
} from './advanced';
import { prepareSearchQuery } from './aliases';
import { narrowByQuery, resolveDocRefs, type RelatedFile } from './blank-forms';
import { splitText } from './chunker';
import { RAG } from './config';
import { embed, embedOne } from './embeddings';
import { matchFaq } from './faq';
import { resolveIntent, type Intent } from './intent';
import { chatStream, type ChatMessage } from './llm';
import { needsPlanner, planQuery } from './planner';
import { rerank } from './reranker';
import {
  fetchChunksByArticleNo,
  hybridSearch,
  isStoreAlive,
  parseArticleNo,
  toSource,
  type RetrievedChunk,
  type SourceItem,
} from './retriever';
import { correctTypos } from './spellfix';
import {
  countArticles,
  countUnits,
  exactArticleByMeta,
  exactArticleRetrieve,
  exactUnitsByMeta,
  expandWithLinkedArticles,
  extremeArticleByMeta,
  extremeUnitByMeta,
  findExtremeArticleNumber,
  fmtArticleNo,
  listQueryRetrieve,
  pickRelevantDocument,
  rangeArticlesByMeta,
  rangeUnitsByMeta,
  resolveDocHint,
} from './structured';
import {
  buildRagPrompt,
  SYSTEM_PROMPT_ATTACHMENT,
  SYSTEM_PROMPT_CHAT,
  SYSTEM_PROMPT_COMPARE,
  SYSTEM_PROMPT_RAG,
  SYSTEM_PROMPT_SMALLTALK,
  type PromptChunk,
} from './prompts';

// Оркестрация ответа ассистента. Порт RAGPipeline.answer_stream() и
// RAGPipeline._retrieve() из services/rag/pipeline.py: spellfix → intent →
// гейты болтовни → FAQ → планировщик/поиск → сбор контекста → системный
// промпт → генерация → источники.
//
// В FastAPI остались только импорт FAQ-таблиц (docx) и генерация документов по
// шаблонам; продвинутые ветки RAG (планировщик, HyDE, декомпозиция, темы,
// self-check, сводка диалога) перенесены сюда и включаются теми же флагами
// окружения — см. lib/ml/config.ts.

// ---------------------------------------------------------------------------
// Юникод-регэкспы
// ---------------------------------------------------------------------------
// В Python `\w` и `\b` знают кириллицу, в JS — только ASCII: `/\bстатья/` не
// матчится вовсе. Поэтому компилируем «питоновские» шаблоны, подставляя
// расширенный класс слова и корректную границу слова.

const W = '0-9A-Za-zА-Яа-яЁё_';
const B = `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`;

function ru(pattern: string, flags = 'i'): RegExp {
  return new RegExp(pattern.replace(/\\b/g, B).replace(/\\w/g, `[${W}]`), flags);
}

// Составные номера сохраняем целиком: «статья 84.1».
const EXACT_ARTICLE_ANCHOR_RE = ru('\\b(?:стат\\w*|ст\\.?)\\s+(?:номер\\s+|№\\s*)?(\\d+(?:\\.\\d+)?)', 'gi');
// Обратный порядок: «3 статью», «47 ст.».
const EXACT_ARTICLE_ANCHOR_REVERSE_RE = ru('\\b(\\d+(?:\\.\\d+)?)\\s+(?:стат\\w*|ст\\.)', 'gi');
// После найденного номера в небольшом окне — дополнительные через «, и или».
const EXTRA_NUMBER_RE = /(?:[,;]|\sи\s|\sили\s)\s*(\d+(?:\.\d+)?)/gi;
// Другая структурная единица в хвосте — значит перечисление уже не про статьи.
const OTHER_UNIT_RE = ru('\\b(?:год|глав|пункт|раздел|часть|кварт)\\w*', 'i');

/** Все номера статей из запроса («статьи 80, 81 и 82», «ст. 192 и 193»). */
export function extractArticleNumbers(query: string): string[] {
  const q = query || '';
  const out: string[] = [];

  EXACT_ARTICLE_ANCHOR_RE.lastIndex = 0;
  for (const anchor of q.matchAll(EXACT_ARTICLE_ANCHOR_RE)) {
    if (!out.includes(anchor[1])) out.push(anchor[1]);
    const end = (anchor.index ?? 0) + anchor[0].length;
    const tail = q.slice(end, end + 80);
    for (const m of tail.matchAll(EXTRA_NUMBER_RE)) {
      if (OTHER_UNIT_RE.test(tail.slice(0, m.index ?? 0))) break;
      if (!out.includes(m[1])) out.push(m[1]);
    }
  }

  for (const anchor of q.matchAll(EXACT_ARTICLE_ANCHOR_REVERSE_RE)) {
    if (!out.includes(anchor[1])) out.push(anchor[1]);
  }
  return out;
}

// Болтовня/благодарности/приветствия: их нельзя гнать через RAG — иначе на
// «спасибо» идёт поиск и выдаётся шаблонный отказ «нет в базе».
const GREET_RE = ru(
  '\\b(спасибо|благодар|спс|пожалуйста|привет|здравствуй|здаров|добрый день|' +
    'добрый вечер|доброе утро|пока|до свидания|всего доброго|увидимся|' +
    'понял|поняла|понятно|ясно|ок|окей|хорошо|ладно|круто|отлично|супер|класс)\\b'
);
// ВАЖНО: «?» здесь НЕ признак информационного запроса — иначе «Привет, это кто?»
// уходил бы в RAG и получал отказ вместо живого ответа.
const INFO_RE = ru(
  '\\b(расскажи|объясни|подскажи|сравни|покажи|найди|перечисли|опиши|дай|' +
    'сформулируй|назов\\w*|привед\\w*|процитир\\w*|как |какой|какая|какие|сколько|когда|где|почему|зачем|' +
    'можно ли|нужно|вправе|обязан|стать|пункт\\w*|подпункт\\w*|положени\\w*|раздел|глав|' +
    'номер\\w*|текст\\w*|выдержк\\w*|договор|отпуск|' +
    'увольн|уволи|приём|прием|зарплат|оклад|преми|кодекс|закон|норм|срок|' +
    'документ|оформ|порядок|право|гарант)\\b'
);
// Вопрос про новости HR-отдела → отвечаем из ленты /news.
const NEWS_RE = ru('\\b(новост\\w*|анонс\\w*|дайджест\\w*|объявлени\\w*)\\b|что\\s+нового|что\\s+новенького');
// «Выдай/дай бланк/образец/шаблон/форму заявления …» → отдаём файл(ы) карточками,
// без длинного RAG-ответа по нормативке (протокол: бот ВЫДАЁТ бланк).
const BLANK_RE = ru(
  '\\b(бланк\\w*|образ(?:ец|цы|ца|цов)|шаблон\\w*)\\b' +
    '|\\b(выдай|дай|дать|нужн\\w+|скачать|пришл\\w+|предостав\\w+|получить|хочу)\\b' +
    '[^.]{0,40}\\b(заявлени\\w*|записк\\w*|форм\\w*|документ\\w*)\\b'
);
// Социальные вопросы о самом ассистенте — разговорный ответ без поиска.
const SOCIAL_RE = ru(
  '\\b(кто\\s+ты|ты\\s+кто|это\\s+кто|кто\\s+это|как\\s+тебя\\s+зовут|ты\\s+бот|' +
    'ты\\s+человек|ты\\s+робот|что\\s+ты\\s+умеешь|что\\s+умеешь|чем\\s+можешь\\s+помочь|' +
    'чем\\s+поможешь|как\\s+дела|как\\s+ты|что\\s+делаешь)\\b'
);
// Короткие уточняющие продолжения по той же теме («а подробнее?», «процитируй её»).
const FOLLOWUP_MARKER_RE = ru(
  '\\b(её|ее|неё|нее|его|них|это|этот|эту|этой|этом|там|туда|оттуда|отсюда|выше|тут|здесь)\\b' +
    '|из\\s+н(?:его|её|ее|их)\\b' +
    '|подробн|целиком|полност|дальше|продолж|процитир|разверн|раскрой' +
    '|\\bа\\s+(что|как|где|когда|почему|зачем|если)\\b|ещё|\\bеще\\b'
);
// Арифметика/числа («1+1», «2*3=»), пустой набор символов.
const ARITHMETIC_RE = /^[\d\s+\-*\/=^%.,()]+$/;
// Структурные сигналы («положение номер 3.2») проверяет needsPlanner из
// planner.ts — тот же список, что гейтит вызов планировщика в Python.

function isSmalltalk(query: string): boolean {
  const q = (query || '').trim();
  if (!q || q.length > 160) return false;
  if (SOCIAL_RE.test(q)) return true;
  return GREET_RE.test(q) && !INFO_RE.test(q);
}

function isFollowup(query: string, history: HistoryEntry[] | undefined): boolean {
  const q = (query || '').trim();
  if (!history?.length || !q || q.length > 80) return false;
  return FOLLOWUP_MARKER_RE.test(q);
}

/** Тривиальные/мусорные запросы («1+1», «вавыы»), не требующие документов. */
function looksNonknowledge(query: string): boolean {
  const q = (query || '').trim();
  if (!q) return false;
  if (ARITHMETIC_RE.test(q)) return true;
  if (INFO_RE.test(q)) return false;
  if (extractArticleNumbers(q).length) return false;
  // Число в HR-запросе почти всегда адресное («положение 3.2», «пункт 5»).
  if (/\d/.test(q)) return false;
  return q.length <= 40;
}

// Обзорные запросы по документу и «про сам документ» (для вложений).
const OVERVIEW_RE = ru(
  '(переска\\w+|кратк\\w+|вкратц\\w+|о\\s+ч[её]м|содержани\\w+|суть|резюм\\w+|' +
    'summary|обзор|главн\\w+\\s+мысл|основн\\w+\\s+(?:мысл|положени|идеи))'
);
const ABOUT_ATTACHMENT_RE = ru(
  '\\b(документ\\w*|файл\\w*|вложени\\w*|тексте?|прикреплённ\\w*|прикреплен\\w*|здесь|тут)\\b'
);

// ---------------------------------------------------------------------------
// Пост-обработка ответа (порт services/rag/post_process.py)
// ---------------------------------------------------------------------------

const THINK_RE = /<think>[\s\S]*?<\/think>\s*/gi;
const THINK_OPEN_RE = /^\s*<think>[^\n]*/i;
// Иероглифы CJK — артефакт мультиязычной токенизации Qwen3; у нас всё на русском.
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]+/g;

function dedupeParagraphs(answer: string, maxRepeats = 1): string {
  if (!answer) return answer;
  const paragraphs = answer.split(/\n\s*\n+/);
  const out: string[] = [];
  let last: string | null = null;
  let count = 0;
  for (const p of paragraphs) {
    const key = p.trim().replace(/\s+/g, ' ').toLowerCase();
    if (key && key === last) {
      count += 1;
      if (count > maxRepeats) continue;
    } else {
      last = key;
      count = 0;
    }
    out.push(p);
  }
  return out.join('\n\n');
}

/** Финальная обработка: убрать <think>-блоки, иероглифы, дедуп повторов. */
export function postProcessAnswer(answer: string): string {
  if (!answer) return answer;
  let out = answer.replace(THINK_RE, '');
  out = out.replace(THINK_OPEN_RE, '');
  out = out.replace(/^\s+/, '');
  // Заменяем на маркер «[?]»: пользователь сразу увидит, что модель сломалась.
  out = out.replace(CJK_RE, '[?]');
  return dedupeParagraphs(out);
}

const REF_RE = /\[(\d{1,3})\]/;
const SOURCES_HDR_RE = /^#{0,6}\s*источник[а-яё]*\s*[:：]?\s*$|\n##\s*Источники/im;
const HEADING_RE = /^#{1,6}\s/;
const CITE_SIM_THRESHOLD = 0.4;

function cos(a: number[], b: number[]): number {
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return s / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Модель часто пишет блок «Источники», но забывает инлайн-ссылки [k] в тексте.
 * Если в ТЕЛЕ ответа нет ни одной ссылки — расставляем их по близости абзаца к
 * чанку-источнику ([k] ↔ sourceTexts[k-1]). Абзацы без уверенного соответствия
 * не трогаем: ложная атрибуция хуже отсутствующей.
 */
export async function ensureInlineCitations(
  answer: string,
  sourceTexts: string[] | null | undefined
): Promise<string> {
  if (!answer || !sourceTexts?.length) return answer;

  const m = SOURCES_HDR_RE.exec(answer);
  const body = m ? answer.slice(0, m.index) : answer;
  const tail = m ? answer.slice(m.index) : '';
  if (REF_RE.test(body)) return answer; // инлайн-ссылки уже есть

  // split с захватывающей группой сохраняет разделители — как re.split в Python.
  const paragraphs = body.split(/(\n\s*\n+)/);
  try {
    const srcVecs = await embed(
      sourceTexts.map((t) => t.slice(0, 1500)),
      false
    );
    let changed = false;
    for (let i = 0; i < paragraphs.length; i += 2) {
      const p = paragraphs[i];
      const stripped = p.trim();
      if (stripped.length < 60 || HEADING_RE.test(stripped)) continue;
      const pv = await embedOne(stripped.slice(0, 1500), false);
      const sims = srcVecs.map((sv) => cos(pv, sv));
      let best = 0;
      for (let j = 1; j < sims.length; j++) if (sims[j] > sims[best]) best = j;
      if (sims[best] < CITE_SIM_THRESHOLD) continue;
      paragraphs[i] = `${p.replace(/\s+$/u, '')} [${best + 1}]`;
      changed = true;
    }
    if (changed) return paragraphs.join('') + tail;
  } catch {
    /* авторасстановка не удалась — отдаём ответ как есть */
  }
  return answer;
}

// ---------------------------------------------------------------------------
// Вложения: разбиение и выбор релевантных фрагментов
// ---------------------------------------------------------------------------

const ATTACHMENT_MAX_CHARS = 6000; // лимит на один передаваемый фрагмент
const ATTACHMENT_MAX_CHUNKS = 4; // сколько фрагментов вложения отдать в контекст
const KB_SUPPORT_WITH_ATTACHMENT = 2; // сколько KB-выдержек оставить подкреплением

/** Равномерная выборка по всему документу (для обзорных запросов). */
function spreadSample(chunks: string[], k: number): string[] {
  if (chunks.length <= k) return chunks;
  const idxs = new Set<number>();
  for (let i = 0; i < k; i++) idxs.add(Math.round((i * (chunks.length - 1)) / (k - 1)));
  return [...idxs].sort((a, b) => a - b).map((i) => chunks[i]).slice(0, k);
}

/** Косинусная близость чанков вложения к запросу — top-k в исходном порядке. */
async function rankAttachmentChunks(query: string, chunks: string[], k: number): Promise<string[]> {
  if (chunks.length <= k) return chunks;
  try {
    const qv = await embedOne(query, true);
    const mat = await embed(chunks, false);
    const sims = mat.map((v) => cos(v, qv));
    const top = sims
      .map((s, i) => [s, i] as [number, number])
      .sort((a, b) => b[0] - a[0])
      .slice(0, k)
      .map(([, i]) => i)
      .sort((a, b) => a - b);
    return top.map((i) => chunks[i]);
  } catch {
    return chunks.slice(0, k);
  }
}

export interface AttachedDoc {
  id?: number | null;
  filename?: string | null;
  content?: string | null;
  stored_path?: string | null;
}

function isOverviewQuery(query: string): boolean {
  const q = (query || '').trim();
  return q.length < 20 || OVERVIEW_RE.test(q);
}

/**
 * Запрос явно про сам приложенный документ. НЕ срабатывает при явном номере
 * статьи — это адресный KB-запрос, нормативку в таком случае оставляем.
 */
function isAboutAttachment(query: string): boolean {
  const q = query || '';
  if (extractArticleNumbers(q).length) return false;
  return OVERVIEW_RE.test(q) || ABOUT_ATTACHMENT_RE.test(q);
}

async function selectAttachmentContext(
  query: string,
  attached: AttachedDoc[]
): Promise<[PromptChunk[], Record<string, unknown>[]]> {
  const ctx: PromptChunk[] = [];
  const srcs: Record<string, unknown>[] = [];
  const overview = isOverviewQuery(query);

  for (const doc of attached) {
    const text = (doc.content || '').trim();
    if (!text) continue;
    const fname = doc.filename || 'файл';
    const attId = doc.id ?? null;

    let picked: string[];
    if (text.length <= ATTACHMENT_MAX_CHARS) {
      picked = [text];
    } else {
      // Тот же чанкер, что у индексатора БЗ (Python здесь тоже зовёт split_text):
      // структурные стратегии режут вложение по разделам, а не «по 600 символов».
      const chunks = splitText(text).map((c) => c.text);
      if (!chunks.length) {
        picked = [text.slice(0, ATTACHMENT_MAX_CHARS)];
      } else if (overview) {
        picked = spreadSample(chunks, ATTACHMENT_MAX_CHUNKS);
      } else {
        picked = await rankAttachmentChunks(query, chunks, ATTACHMENT_MAX_CHUNKS);
      }
      // Страховка по суммарному размеру
      let joined = 0;
      const limited: string[] = [];
      for (const frag of picked) {
        if (joined + frag.length > ATTACHMENT_MAX_CHARS && limited.length) break;
        limited.push(frag);
        joined += frag.length;
      }
      picked = limited.length ? limited : picked.slice(0, 1);
    }

    const multi = picked.length > 1;
    picked.forEach((frag, j) => {
      const title = `Прикреплённый документ «${fname}»${multi ? ` (фрагмент ${j + 1})` : ''}`;
      ctx.push({ title, text: frag, source_uri: 'session' });
      srcs.push({
        title: fname,
        uri: '',
        type: 'attachment',
        document_id: null,
        attachment_id: attId,
        article: null,
        score: 1.0,
        priority: 2,
      });
    });
  }
  return [ctx, srcs];
}

// ---------------------------------------------------------------------------
// Новости HR
// ---------------------------------------------------------------------------

/** Последние опубликованные новости → чанки контекста + источники. */
async function recentNewsContext(limit = 6): Promise<[PromptChunk[], Record<string, unknown>[]]> {
  const posts = await prisma.news_posts.findMany({
    where: { is_published: true },
    orderBy: [{ is_pinned: 'desc' }, { created_at: 'desc' }],
    take: limit,
    select: { id: true, title: true, body_html: true, created_at: true },
  });

  const ctx: PromptChunk[] = [];
  const srcs: Record<string, unknown>[] = [];
  for (const p of posts) {
    const text = (p.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // В БД лежит наивный UTC — берём UTC-компоненты, иначе дата «поедет» на зону.
    const d = p.created_at;
    const date = d
      ? `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`
      : '';
    const title = p.title || 'Новость';
    ctx.push({
      title: `Новость HR: ${title}`,
      text: `Дата публикации: ${date}.\n${text}`.trim(),
      source_uri: `/news/${p.id}`,
    });
    srcs.push({ title: `Новость HR: ${title}`, source_type: 'news', url: `/news/${p.id}` });
  }
  return [ctx, srcs];
}

// ---------------------------------------------------------------------------
// Поиск по базе знаний
// ---------------------------------------------------------------------------

/**
 * Для топ-`maxFull` статей подтягивает ВСЕ их чанки — полная статья в контексте.
 * Перечни и основания бывают глубоко в длинной статье, а реранкер поднимает
 * лишь один её фрагмент. Полные статьи идут первыми.
 */
async function augmentWithArticles(
  chunks: RetrievedChunk[],
  maxFull = 2
): Promise<RetrievedChunk[]> {
  const existing = new Set(chunks.map((c) => `${c.document_id}:${c.chunk_index}`));
  const seenArts = new Set<string>();
  const extra: RetrievedChunk[] = [];

  for (const c of chunks) {
    const no = parseArticleNo(c.text);
    if (no === null || seenArts.has(`${no}:${c.document_id}`)) continue;
    if (seenArts.size >= maxFull) break;
    seenArts.add(`${no}:${c.document_id}`);
    try {
      const full = await fetchChunksByArticleNo(no, c.document_id, 12);
      for (const h of full) {
        const key = `${h.document_id}:${h.chunk_index}`;
        if (existing.has(key)) continue;
        extra.push({ ...h, score: c.score });
        existing.add(key);
      }
    } catch {
      continue;
    }
  }
  return [...extra, ...chunks];
}

/**
 * Текст последних реплик для разрешения референсных follow-up-запросов
 * («процитируй её»). Берём последние maxTurns пар, обрезаем по длине.
 */
function historyContext(history: HistoryEntry[] | undefined, maxTurns = 2): string {
  if (!history?.length) return '';
  return history
    .slice(-(maxTurns * 2))
    .map((m) => {
      const role = m.role === 'user' ? 'Пользователь' : 'Ассистент';
      const content = (m.content || '').trim().replace(/\n/g, ' ');
      return content ? `${role}: ${content.slice(0, 400)}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Поиск по плану запроса. Возвращает [чанки, использованные подзапросы].
 * Порт RAGPipeline._retrieve: сперва структурные режимы планировщика (они
 * отвечают детерминированно по индексу), затем обычный семантический путь.
 */
async function retrieve(
  query: string,
  onStatus?: (stage: string) => void,
  history?: HistoryEntry[]
): Promise<[RetrievedChunk[], string[]]> {
  onStatus?.('search');

  // Планировщик: NL → структурный план. История нужна, чтобы разрешать ссылки
  // «её/эту статью» из прошлых реплик.
  const plan = await planQuery(query, historyContext(history));
  const isArticle = plan.unit === 'article';
  const planText = plan.search_text || query;

  // --- exact: «статья 81», «раздел 3», «пункт 5» ---
  if (plan.mode === 'exact_article' && plan.article_nos.length) {
    // Привязка к документу: сперва явная подсказка («ТК», «коллективный
    // договор»), иначе семантическое голосование. Без неё «пункт 3» выбирался
    // бы по ВСЕЙ базе и контекст заполняли пункты 3 чужих документов. Пустой
    // результат в выбранном документе → откат к глобальному поиску.
    const docId = (await resolveDocHint(plan.doc_hint)) ?? (await pickRelevantDocument(planText));
    let chunks: RetrievedChunk[];
    if (isArticle) {
      chunks = await exactArticleByMeta(plan.article_nos, docId);
      if (!chunks.length && docId !== null) chunks = await exactArticleByMeta(plan.article_nos, null);
      // Старые данные без article_no — текстовый фолбэк.
      if (!chunks.length) chunks = await exactArticleRetrieve(plan.article_nos.map(fmtArticleNo));
    } else {
      chunks = await exactUnitsByMeta(plan.unit, plan.article_nos, docId);
      if (!chunks.length && docId !== null) chunks = await exactUnitsByMeta(plan.unit, plan.article_nos, null);
    }
    if (chunks.length) {
      if (isArticle) chunks = await expandWithLinkedArticles(chunks, 2);
      return [chunks, [planText]];
    }
  }

  // --- extreme: «первая/последняя статья/раздел/глава/пункт» ---
  if (plan.mode === 'extreme' && plan.extreme) {
    let chunks: RetrievedChunk[];
    if (isArticle) {
      chunks = await extremeArticleByMeta(plan.extreme, planText, plan.doc_hint);
      if (!chunks.length) {
        const no = await findExtremeArticleNumber(plan.extreme); // фолбэк на скан заголовков
        if (no) chunks = await exactArticleRetrieve([no]);
      }
    } else {
      chunks = await extremeUnitByMeta(plan.unit, plan.extreme, planText, plan.doc_hint);
    }
    if (chunks.length) return [chunks, [planText]];
  }

  // --- range: «первые/последние N статей/разделов/пунктов» ---
  if (plan.mode === 'range' && plan.range_n) {
    let chunks: RetrievedChunk[];
    if (isArticle) {
      chunks = await rangeArticlesByMeta(plan.range_n, plan.range_order, planText, plan.doc_hint);
      if (!chunks.length) chunks = await listQueryRetrieve(planText, plan.range_n, plan.range_order);
    } else {
      chunks = await rangeUnitsByMeta(plan.unit, plan.range_n, plan.range_order, planText, plan.doc_hint);
    }
    if (chunks.length) return [chunks, [planText]];
  }

  // --- count: «сколько статей/разделов/глав» ---
  if (plan.mode === 'count') {
    const chunks = isArticle
      ? await countArticles(planText, plan.doc_hint)
      : await countUnits(plan.unit, planText, plan.doc_hint);
    if (chunks.length) return [chunks, [planText]];
  }

  // --- Safety net: план мог быть semantic, но в запросе явно «статья N» ---
  if (plan.mode === 'semantic') {
    const explicit = extractArticleNumbers(query);
    if (explicit.length) {
      const chunks = await exactArticleRetrieve(explicit);
      if (chunks.length) return [await expandWithLinkedArticles(chunks, 2), [query]];
    }
  }

  // === Семантический путь (semantic | compare) ===
  // Шаг 0: переписываем запрос, если есть отрицания.
  const rewritten = await maybeRewriteQuery(query);
  // Темы для приоритизации тегов — необязательно, дёшево, если LLM свободна.
  const topics = RAG.useTopicClassify ? await classifyTopics(rewritten) : [];
  const subqueries = await maybeDecompose(rewritten);
  // Декомпозиция ДОПОЛНЯЕТ, а не заменяет оригинал: иначе для развёрнутых
  // формулировок поиск идёт только по узким подвопросам и главная статья не
  // попадает в пул.
  const searchSet = [...new Set([rewritten, ...subqueries])];

  const allCandidates: RetrievedChunk[] = [];
  for (const sub of searchSet) {
    // Поисковый запрос расширяем аббревиатурами и юр-синонимами (+ HyDE, если
    // включён); реранк идёт по ИСХОДНОЙ формулировке — так же, как в Python.
    const searchQuery = await maybeHyde(prepareSearchQuery(sub));
    allCandidates.push(...(await hybridSearch(searchQuery, { topics: topics.length ? topics : null })));
  }

  // Дедуп по (document_id, chunk_index, начало текста)
  const seen = new Set<string>();
  const uniq: RetrievedChunk[] = [];
  for (const c of allCandidates) {
    const key = `${c.document_id}:${c.chunk_index}:${c.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  if (!uniq.length) return [[], subqueries];

  onStatus?.('rerank');
  const top = await rerank(query, uniq);
  // Safety-net: реранкер бывает уверенно неправ и выбрасывает сильный результат
  // гибридного поиска. Гарантируем, что топ-N RRF дойдут до контекста —
  // реранкер переупорядочивает, но не теряет.
  const keys = new Set(top.map((c) => `${c.document_id}:${c.chunk_index}`));
  for (const c of uniq.slice(0, RAG.rerankRrfKeep)) {
    const key = `${c.document_id}:${c.chunk_index}`;
    if (!keys.has(key)) {
      top.push(c);
      keys.add(key);
    }
  }
  return [await augmentWithArticles(top), subqueries];
}

// ---------------------------------------------------------------------------
// Главный вход
// ---------------------------------------------------------------------------

export type HistoryEntry = ChatMessage;

export interface AnswerOptions {
  history?: HistoryEntry[];
  useRag?: boolean;
  attachedDocuments?: AttachedDoc[];
  dialogueSummary?: string | null;
  onStatus?: (stage: string) => void;
  extraContext?: string | null;
  /** Для пересланного из мессенджера пустая выдача — не повод для отказа. */
  allowNoContextAnswer?: boolean;
  userId?: number | null;
  onPosition?: (position: number, total: number) => void;
  signal?: AbortSignal;
  /** Готовое намерение от вызывающего кода; null — определяем сами. */
  intentHint?: Intent | null;
}

export interface AnswerResult {
  stream: AsyncGenerator<string>;
  sources: (SourceItem | Record<string, unknown>)[];
  usedSubqueries: string[];
  /** Тексты чанков, ушедших в контекст LLM — для восстановления ссылок [k]. */
  contextTexts: string[];
  contact: string | null;
  relatedFiles: RelatedFile[];
}

async function* single(text: string): AsyncGenerator<string> {
  yield text;
}

const TEMP_ANSWER = Number(process.env.LLM_ANSWER_TEMPERATURE || 0.1);
const TEMP_SMALLTALK = Number(process.env.LLM_SMALLTALK_TEMPERATURE || 0.7);
const TEMP_CHAT = Number(process.env.LLM_TEMPERATURE || 0.3);

export async function answerStream(query: string, opts: AnswerOptions = {}): Promise<AnswerResult> {
  const {
    history,
    attachedDocuments,
    dialogueSummary,
    onStatus,
    extraContext,
    allowNoContextAnswer = false,
    userId = null,
    onPosition,
    signal,
  } = opts;

  let useRag = opts.useRag ?? true;
  const hasAttachment = Boolean(attachedDocuments?.length);

  // Опечатки ломают регэксп-гейты и BM25 («пиривет» → RAG-отказ вместо
  // приветствия). routed — исправленная версия для роутинга и ПОИСКА; оригинал
  // query остаётся в промпте модели (она сама устойчива к опечаткам).
  let routed = await correctTypos(query);

  const newsQuery = useRag && !hasAttachment && NEWS_RE.test(routed);
  // Запрос на выдачу бланка/образца → прямая отдача файла (см. замыкание ниже).
  const blankRequest = useRag && !hasAttachment && BLANK_RE.test(routed);

  // Контекстное намерение: если вызывающий код его не определил — считаем сами
  // (эмбеддинг-классификатор + LLM для пограничных случаев). null → решают
  // прежние регэксп-гейты ниже.
  let intentHint = opts.intentHint ?? null;
  if (intentHint === null && useRag && !hasAttachment) {
    intentHint = await resolveIntent(routed, history);
  }

  // === Болтовня/мусор решаем ДО FAQ ===
  // Раньше «нечёткое» совпадение с FAQ (порог 0.70) перебивало этот гейт и
  // тянуло «как дела?» в поиск. Сначала определяем болтовню — и только если
  // реально ищем, спрашиваем FAQ-матчер.
  let casual = false;
  if (useRag && !hasAttachment && !newsQuery && !isFollowup(routed, history)) {
    // Жёсткий предохранитель смешанного сообщения («Привет! … текст 28 статьи»):
    // явный информационный сигнал → это НЕ болтовня, что бы ни решил классификатор.
    const hasInfoSignal = INFO_RE.test(routed) || extractArticleNumbers(routed).length > 0;
    // SOCIAL_RE («как дела», «кто ты») — ОДНОЗНАЧНАЯ болтовня о самом ассистенте;
    // её нельзя перебивать широким инфо-триггером «как ».
    const isSmall =
      SOCIAL_RE.test(routed) ||
      ((intentHint === 'smalltalk' || isSmalltalk(routed)) && !hasInfoSignal);
    // Гейт мусора НЕ перебивает классификатор и планировщик: содержательный
    // интент или структурные сигналы («положение номер 3.2») обязывают искать,
    // иначе модель выдумает текст пункта.
    const looksTrash =
      intentHint !== 'kb_question' && !needsPlanner(routed) && looksNonknowledge(routed);
    if (isSmall || looksTrash) {
      useRag = false;
      casual = isSmall;
    } else if (intentHint === 'meta_chat' && history?.length) {
      // Вопрос о самой переписке → ответ по истории, без поиска по БЗ
      // (retrieval по такой фразе тянет случайные документы).
      useRag = false;
    }
  }

  // === FAQ отдела кадров — только если реально ищем ===
  // Курируемые ответы из файлов «чат-бот …»: совпадение по вариантам
  // формулировок ОБОГАЩАЕТ контекст LLM (первый чанк + контакт в футер).
  let faqCtx: PromptChunk[] = [];
  let faqSources: Record<string, unknown>[] = [];
  let faqContact: string | null = null;
  let relatedFiles: RelatedFile[] = [];

  if (useRag && !hasAttachment) {
    const faqHit = await matchFaq(routed, history).catch(() => null);
    if (faqHit) {
      faqContact = faqHit.contact;
      if (faqHit.rewritten_query) routed = faqHit.rewritten_query;
      let text = faqHit.answer;
      if (faqHit.doc_refs.length) {
        text += `\n\nСвязанные документы: ${faqHit.doc_refs.join('; ')}`;
        // Названия документов → реальные файлы → карточки «Скачать».
        relatedFiles = await resolveDocRefs(faqHit.doc_refs);
      }
      if (text.trim()) {
        const title = `FAQ отдела кадров: ${faqHit.block}`;
        faqCtx = [{ title, text, source_uri: 'faq' }];
        faqSources = [{ title, source_type: 'faq' }];
      }
    }
  }

  // === Короткое замыкание «выдай бланк» ===
  // Пользователь просит бланк, а нужные файлы уже найдены — отдаём их напрямую
  // коротким ответом, без RAG-поиска и LLM (иначе бот уходит в рассуждения по
  // нормативке). Сужаем до запрошенного бланка.
  if (blankRequest && relatedFiles.length) {
    const narrowed = narrowByQuery(query, relatedFiles);
    let canned: string;
    if (narrowed.length === 1) {
      const f = narrowed[0];
      const noun = f.kind === 'template' ? 'бланк' : 'документ';
      canned = `Вот ${noun} «${f.title}» — откройте или скачайте ниже.`;
      if (f.kind === 'template') canned += ' Заполнять его не нужно, шаблон готов к использованию.';
    } else {
      canned =
        'Подходящие бланки — откройте или скачайте ниже. ' +
        'Заполнять их не нужно, шаблоны готовы к использованию.';
    }
    onStatus?.('generate');
    return {
      stream: single(canned),
      sources: [],
      usedSubqueries: [],
      contextTexts: [],
      contact: faqContact,
      relatedFiles: narrowed,
    };
  }

  // === Новости HR ===
  let newsCtx: PromptChunk[] = [];
  let newsSources: Record<string, unknown>[] = [];
  if (newsQuery) {
    try {
      [newsCtx, newsSources] = await recentNewsContext();
    } catch {
      /* лента недоступна — отвечаем без неё */
    }
  }

  // === KB-выдержки ===
  let kbCtx: PromptChunk[] = [];
  let kbSources: SourceItem[] = [];
  let subqueries: string[] = [];
  if (useRag && !newsCtx.length) {
    let topChunks: RetrievedChunk[] = [];
    try {
      [topChunks, subqueries] = await retrieve(routed, onStatus, history);
    } catch {
      topChunks = []; // поиск упал — отвечаем обычным чатом
    }
    // При вложении KB — лишь подкрепление: ограничиваем, чтобы не «утопить»
    // содержание прикреплённого документа нормативкой.
    if (hasAttachment && topChunks.length) {
      const kbKeep = isAboutAttachment(routed) ? 0 : KB_SUPPORT_WITH_ATTACHMENT;
      topChunks = topChunks.slice(0, kbKeep);
    }
    if (topChunks.length) {
      kbSources = topChunks.map(toSource);
      kbCtx = topChunks.map((c) => ({ title: c.title, text: c.text, source_uri: c.source_uri }));
    }
  }

  // === Прикреплённый документ ===
  let attCtx: PromptChunk[] = [];
  let attSources: Record<string, unknown>[] = [];
  if (hasAttachment) {
    [attCtx, attSources] = await selectAttachmentContext(routed, attachedDocuments as AttachedDoc[]);
  }

  // Вложение идёт ПЕРВЫМ (основной материал), затем новости, курируемый FAQ,
  // KB — следом (подкрепление). sources строго в том же порядке, что и
  // contextChunks → [k] ↔ sources[k-1].
  const contextChunks = [...attCtx, ...newsCtx, ...faqCtx, ...kbCtx];
  const sources = [...attSources, ...newsSources, ...faqSources, ...kbSources];

  // === SHORT-CIRCUIT: «выдержек нет» ===
  // Если пользователь явно запросил RAG, но не нашлось НИ ОДНОГО чанка и нет
  // вложений — НЕ зовём LLM: иначе она сочинит ответ «по памяти».
  if (
    useRag &&
    !contextChunks.length &&
    !hasAttachment &&
    !allowNoContextAnswer &&
    query.trim().length >= 12
  ) {
    onStatus?.('generate');
    // Отличаем «база знаний недоступна» от «нет релевантных документов».
    const alive = await isStoreAlive();
    const canned = alive
      ? 'В предоставленных выдержках информации по вашему вопросу нет.\n\n' +
        'Возможные причины:\n' +
        '- эта тема не покрыта документами, загруженными в базу знаний;\n' +
        '- формулировка запроса не позволила найти нужный фрагмент.\n\n' +
        '**Что можно сделать:**\n' +
        '- Уточнить запрос — например, указать номер статьи, название документа или конкретный термин.\n' +
        '- Проверить актуальную редакцию официального документа напрямую (например, на «КонсультантПлюс» или «Гарант»).'
      : '⚠️ **База знаний временно недоступна** — нет связи с сервером поиска (Qdrant).\n\n' +
        'Ответить по документам сейчас не получится. Обратитесь к администратору, ' +
        'чтобы проверить, запущен ли сервис Qdrant (по умолчанию `localhost:6333`).';

    return {
      stream: single(canned),
      sources: [],
      usedSubqueries: subqueries,
      contextTexts: [],
      contact: null,
      relatedFiles: [],
    };
  }

  onStatus?.('generate');

  // Системный промпт: при вложении — отвечать по его содержанию, KB как справка.
  let system: string;
  if (hasAttachment && attCtx.length) system = SYSTEM_PROMPT_ATTACHMENT;
  else if (casual) system = SYSTEM_PROMPT_SMALLTALK;
  else if (!contextChunks.length) system = SYSTEM_PROMPT_CHAT;
  else if (isCompareQuery(routed)) system = SYSTEM_PROMPT_COMPARE;
  else system = SYSTEM_PROMPT_RAG;

  if (dialogueSummary) {
    system = `${system}\n\nСводка предыдущей части диалога:\n${dialogueSummary.trim()}`;
  }
  if (extraContext) system = `${system}\n\n${extraContext.trim()}`;

  const userMsg = contextChunks.length ? buildRagPrompt(query, contextChunks) : query;

  // Динамическая температура: факты по выдержкам — минимальная (детерминизм),
  // неформальный разговор — высокая, обычный чат без контекста — средняя.
  const temperature = contextChunks.length ? TEMP_ANSWER : casual ? TEMP_SMALLTALK : TEMP_CHAT;

  return {
    stream: chatStream({
      system,
      user: userMsg,
      history: history ?? [],
      temperature,
      signal,
      userId,
      onPosition,
    }),
    sources,
    usedSubqueries: subqueries,
    contextTexts: contextChunks.map((c) => c.text || ''),
    contact: faqContact,
    relatedFiles,
  };
}
