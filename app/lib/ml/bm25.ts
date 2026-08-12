import 'server-only';

// Лексический поиск BM25 с морфологической нормализацией русского.
// Порт services/rag/retriever.py (_tokenize, _RU_STOP, BM25Okapi).
//
// Морфология повторяет слои оригинала: сначала лемматизация (Az.js работает на
// тех же словарях OpenCorpora, что и pymorphy3 в Python, и даёт те же нормальные
// формы: «уволен» → «уволить»), при её недоступности — стеммер Snowball, затем
// исходное слово. Нормализация обязана быть одинаковой для корпуса и запроса,
// иначе токены перестают совпадать и лексический поиск деградирует.

// Составные номера («3.2», «84.1») остаются одним токеном: иначе «пункт 3.2»
// рассыпается на «3» и «2», и BM25 перестаёт находить пункт по номеру.
const TOKEN_RE = /\d+(?:\.\d+)+|[\wа-яёА-ЯЁ]+/gu;

// Только служебные слова. Отрицания («не», «без», «нет») НЕ включены: в
// нормативных текстах они несут смысл («без уважительных причин»).
const RU_STOP = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'у', 'же', 'по', 'за', 'от',
  'о', 'об', 'обо', 'из', 'изо', 'для', 'при', 'про', 'до', 'над', 'под',
  'подо', 'через', 'между', 'а', 'но', 'или', 'либо', 'что', 'как', 'так',
  'это', 'этот', 'эта', 'эти', 'этого', 'этой', 'этом', 'тот', 'та', 'те',
  'он', 'она', 'оно', 'они', 'его', 'ее', 'её', 'их', 'им', 'ему', 'ей',
  'я', 'ты', 'мы', 'вы', 'мне', 'меня', 'тебя', 'нас', 'вас', 'них', 'ним',
  'ней', 'быть', 'был', 'была', 'было', 'были', 'есть', 'бы', 'ли',
]);

type Stemmer = { stem: (word: string) => string };
type MorphParse = { normalize: () => { word: string } };
type MorphFn = ((word: string) => MorphParse[]) & {
  init: (path: string, cb: (err?: Error) => void) => void;
};

let stemmer: Stemmer | null = null;
let morph: MorphFn | null = null;
const normCache = new Map<string, string>();

function normalize(word: string): string {
  const cached = normCache.get(word);
  if (cached !== undefined) return cached;

  let result = word;
  if (morph) {
    try {
      const parses = morph(word);
      // Первый разбор — самый вероятный, как `morph.parse(w)[0]` в pymorphy.
      if (parses?.length) result = parses[0].normalize().word;
    } catch {
      result = word;
    }
  } else if (stemmer) {
    try {
      result = stemmer.stem(word);
    } catch {
      result = word;
    }
  }
  // В юридических текстах слова часто повторяются — кэш заметно ускоряет.
  if (normCache.size < 100_000) normCache.set(word, result);
  return result;
}

/**
 * Подключает морфологию. Порядок слоёв — как в Python:
 * лемматизация → стемминг → без нормализации.
 */
export async function initStemmer(): Promise<void> {
  if (morph || stemmer) return;

  // Az.js загружает словари OpenCorpora с диска (~10 МБ), поэтому инициализация
  // асинхронная и делается один раз на процесс.
  try {
    const path = await import('node:path');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const az = require('az') as { Morph: MorphFn };
    const dicts = path.join(path.dirname(require.resolve('az/package.json')), 'dicts');
    await new Promise<void>((resolve, reject) => {
      az.Morph.init(dicts, (err?: Error) => (err ? reject(err) : resolve()));
    });
    morph = az.Morph;
    return;
  } catch {
    /* словари не нашлись — идём на стеммер */
  }

  try {
    const mod = await import('snowball-stemmers');
    const factory = (mod as unknown as { newStemmer: (lang: string) => Stemmer }).newStemmer;
    stemmer = factory('russian');
  } catch {
    stemmer = null; // без морфологии — поиск по точным словоформам
  }
}

/** Какой слой морфологии активен — для диагностики. */
export function morphologyMode(): 'lemmatization' | 'stemming' | 'none' {
  if (morph) return 'lemmatization';
  if (stemmer) return 'stemming';
  return 'none';
}

/**
 * Лемма отдельного слова (аналог `_norm_word` в retriever.py). Нужна FAQ-матчеру:
 * он сравнивает наборы лемм без стоп-фильтра, поэтому tokenize не подходит.
 */
export function lemma(word: string): string {
  return normalize(word);
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text || '').matchAll(TOKEN_RE)) {
    const t = raw[0].toLowerCase();
    if (RU_STOP.has(t)) continue;
    // Одиночные буквы — мусор, одиночные цифры («статья 5») сохраняем.
    if (t.length < 2 && !/^\d$/.test(t)) continue;
    out.push(normalize(t));
  }
  return out;
}

/**
 * BM25 Okapi — та же формула и те же параметры, что в rank_bm25,
 * который используется на стороне Python.
 */
export class BM25 {
  private readonly k1 = 1.5;
  private readonly b = 0.75;
  private readonly epsilon = 0.25;

  private docFreqs: Map<string, number>[] = [];
  private docLen: number[] = [];
  private avgdl = 0;
  private idf = new Map<string, number>();

  constructor(corpusTokens: string[][]) {
    this.docLen = corpusTokens.map((d) => d.length);
    const total = this.docLen.reduce((a, b) => a + b, 0);
    this.avgdl = corpusTokens.length ? total / corpusTokens.length : 0;

    const df = new Map<string, number>();
    for (const doc of corpusTokens) {
      const freqs = new Map<string, number>();
      for (const t of doc) freqs.set(t, (freqs.get(t) || 0) + 1);
      this.docFreqs.push(freqs);
      for (const t of freqs.keys()) df.set(t, (df.get(t) || 0) + 1);
    }

    // rank_bm25 подменяет отрицательные IDF на долю среднего значения, иначе
    // очень частые слова получали бы отрицательный вес и «вычитали» релевантность.
    const n = corpusTokens.length;
    let idfSum = 0;
    const negative: string[] = [];
    for (const [term, freq] of df) {
      const value = Math.log(n - freq + 0.5) - Math.log(freq + 0.5);
      this.idf.set(term, value);
      idfSum += value;
      if (value < 0) negative.push(term);
    }
    const avgIdf = df.size ? idfSum / df.size : 0;
    const floor = this.epsilon * avgIdf;
    for (const term of negative) this.idf.set(term, floor);
  }

  getScores(queryTokens: string[]): number[] {
    const scores = new Array(this.docFreqs.length).fill(0);
    for (const term of queryTokens) {
      const idf = this.idf.get(term);
      if (idf === undefined) continue;
      for (let i = 0; i < this.docFreqs.length; i++) {
        const f = this.docFreqs[i].get(term);
        if (!f) continue;
        const denom = f + this.k1 * (1 - this.b + (this.b * this.docLen[i]) / (this.avgdl || 1));
        scores[i] += (idf * (f * (this.k1 + 1))) / denom;
      }
    }
    return scores;
  }
}

// Индекс держим в памяти процесса — как и Python. Это сознательное
// ограничение: при нескольких инстансах каждый строит свою копию.
const g = globalThis as unknown as {
  __hrBm25?: { index: BM25 | null; meta: Record<string, unknown>[] };
};

export function getBm25State() {
  if (!g.__hrBm25) g.__hrBm25 = { index: null, meta: [] };
  return g.__hrBm25;
}

/** Полная перестройка индекса по чанкам (текст + payload). */
export async function rebuildBm25(chunks: { text: string; [k: string]: unknown }[]) {
  await initStemmer();
  const state = getBm25State();
  state.meta = chunks;
  state.index = chunks.length ? new BM25(chunks.map((c) => tokenize(c.text))) : null;
  return chunks.length;
}

/** Возвращает пары [индекс чанка, вес] с положительным весом. */
export function bm25Search(query: string, topK: number): [number, number][] {
  const state = getBm25State();
  if (!state.index || !state.meta.length) return [];
  const scores = state.index.getScores(tokenize(query));
  return scores
    .map((s, i) => [i, s] as [number, number])
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);
}

/** Reciprocal Rank Fusion — объединение плотного и лексического списков. */
export function rrf(rank: number, k = 60): number {
  return 1 / (k + rank + 1);
}
