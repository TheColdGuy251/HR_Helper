import 'server-only';
import { prisma } from '@/lib/db';
import { initStemmer, lemma } from './bm25';
import { cosine } from './config';
import { embed, embedOne } from './embeddings';
import type { ChatMessage } from './llm';

// Матчинг свободного текста по курируемым FAQ отдела кадров (А2/А3).
// Порт матчинг-части services/rag/faq.py; импорт docx-таблиц остаётся в
// FastAPI (POST /api/kb/faq/import), Next только читает faq_entries.
//
// Матчинг двухступенчатый и полностью локальный (эмбеддинги, без LLM):
//   1) запрос → лучшая группа по вариантам формулировок;
//   2) если группа ветвится — сразу под-ветка (когда запрос её уже называет),
//      иначе сводный контекст из всех под-ответов.

// Порог «запрос совпал с FAQ-блоком»: варианты — короткие фразы, поэтому
// требуем заметно большей близости, чем у intent-прототипов (0.50).
const GROUP_HIT = 0.7;
// Порог выбора под-ветки по метке (метки ещё короче — чуть мягче + substring).
const OPTION_HIT = 0.55;
// Буст при полном вхождении лемм варианта в запрос.
const LEMMA_BOOST = 0.88;

const WS_RE = /\s+/g;
const WORD_RE = /[а-яёa-z]+/gi;

function norm(s: string | null | undefined): string {
  return (s || '').trim().replace(WS_RE, ' ');
}

/**
 * Леммы содержательных слов (≥4 букв) — тот же нормализатор, что у BM25.
 * Если ВСЕ леммы варианта есть в запросе, концепт назван явно и матч бустится
 * («поехать в командировку» ⊇ «командировка», хотя эмбеддинги дают <0.7).
 */
function lemmas(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(text || '').matchAll(WORD_RE)) {
    if (m[0].length >= 4) out.add(lemma(m[0].toLowerCase()));
  }
  return out;
}

function isSubset(small: Set<string>, big: Set<string>): boolean {
  for (const x of small) if (!big.has(x)) return false;
  return true;
}

function optionFirst(label: string | null | undefined): string {
  return norm((label || '').split(' / ')[0]);
}

/** Запрос совпал с конкретной FAQ-записью — её ответ идёт в контекст LLM. */
export interface FaqHit {
  entry_id: number;
  block: string;
  answer: string;
  doc_refs: string[];
  contact: string | null;
  score: number;
  /** Переписанный запрос для KB-поиска (вопрос + выбранная под-ветка). */
  rewritten_query: string | null;
}

interface EntryView {
  id: number;
  block: string;
  answer: string;
  doc_refs: string[];
  contact: string | null;
  clarify_question: string | null;
  option_label: string | null;
  position: number;
}

interface Phrase {
  text: string;
  vec: number[];
  lems: Set<string>;
}

interface OptionPhrase extends Phrase {
  entryId: number;
}

interface Group {
  head: EntryView;
  subs: EntryView[];
  phrases: Phrase[];
  optVecs: OptionPhrase[];
}

// Прогретый матчер живёт в памяти процесса. Промис кэшируем, чтобы
// параллельные запросы ждали одну загрузку, а не запускали N прогревов.
const g = globalThis as unknown as { __hrFaqGroups?: Promise<Map<string, Group>> };

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

async function load(): Promise<Map<string, Group>> {
  await initStemmer(); // леммы вариантов должны считаться той же морфологией
  const rows = await prisma.faq_entries.findMany({
    where: { is_active: true },
    orderBy: [{ group_key: 'asc' }, { position: 'asc' }],
  });

  const byGroup = new Map<string, typeof rows>();
  for (const e of rows) {
    const list = byGroup.get(e.group_key);
    if (list) list.push(e);
    else byGroup.set(e.group_key, [e]);
  }

  const view = (e: (typeof rows)[number]): EntryView => ({
    id: e.id,
    block: e.block,
    answer: e.answer || '',
    doc_refs: asStringList(e.doc_refs),
    contact: e.contact,
    clarify_question: e.clarify_question,
    option_label: e.option_label,
    position: e.position,
  });

  const groups = new Map<string, Group>();
  // Собираем все фразы одним планом — эмбеддинги считаются батчами.
  const plan: { gk: string; kind: 'variant' | 'option'; entryId: number; text: string }[] = [];

  for (const [gk, entries] of byGroup) {
    const head = entries.find((x) => x.position === 0) ?? entries[0];
    const subs = entries.filter((x) => x.position > 0);
    groups.set(gk, { head: view(head), subs: subs.map(view), phrases: [], optVecs: [] });

    for (const v of asStringList(head.variants)) {
      plan.push({ gk, kind: 'variant', entryId: head.id, text: v });
    }
    for (const s of subs) {
      for (const line of (s.option_label || '').split(' / ')) {
        if (norm(line)) plan.push({ gk, kind: 'option', entryId: s.id, text: norm(line) });
      }
    }
  }

  // Нижний регистр перед эмбеддингом: энкодер регистро-зависим, иначе
  // «Как дела?»/«как дела?» дают разные векторы и разный вердикт FAQ.
  const vecs = plan.length ? await embed(plan.map((p) => p.text.toLowerCase()), true) : [];
  plan.forEach((p, i) => {
    const grp = groups.get(p.gk);
    if (!grp) return;
    const entry = { text: p.text, vec: vecs[i], lems: lemmas(p.text) };
    if (p.kind === 'variant') grp.phrases.push(entry);
    else grp.optVecs.push({ ...entry, entryId: p.entryId });
  });

  return groups;
}

function groups(): Promise<Map<string, Group>> {
  if (!g.__hrFaqGroups) {
    g.__hrFaqGroups = load().catch((e) => {
      g.__hrFaqGroups = undefined; // сбой прогрева не кэшируем
      throw e;
    });
  }
  return g.__hrFaqGroups;
}

/**
 * Сбрасывает прогретые прототипы: следующий запрос перечитает faq_entries.
 * Обязателен после любой правки FAQ, иначе бот отвечает по старым данным.
 */
export function invalidateFaqMatcher(): void {
  g.__hrFaqGroups = undefined;
}

function matchOption(
  grp: Group,
  q: string,
  qv: number[],
  qLems: Set<string>,
  history: ChatMessage[] | null | undefined,
  rewritten: boolean
): FaqHit | null {
  if (!grp.subs.length) return null;
  const ql = q.toLowerCase();
  let bestId: number | null = null;
  let bestScore = 0;

  for (const opt of grp.optVecs) {
    let score = cosine(qv, opt.vec);
    const tl = opt.text.toLowerCase();
    if (tl.length >= 4 && (ql.includes(tl) || tl.includes(ql))) score = Math.max(score, 0.9);
    else if (opt.lems.size && isSubset(opt.lems, qLems)) score = Math.max(score, LEMMA_BOOST);
    if (score > bestScore) {
      bestId = opt.entryId;
      bestScore = score;
    }
  }
  if (bestId === null || bestScore < OPTION_HIT) return null;

  const sub = grp.subs.find((s) => s.id === bestId);
  if (!sub) return null;

  let rew: string | null = null;
  if (rewritten) {
    // Исходный вопрос (до уточнения) + выбранная ветка → нормальный поисковый
    // запрос для KB вместо односложного «увольнение».
    let prevUser: string | null = null;
    for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
      const m = (history as ChatMessage[])[i];
      if (m.role === 'user') {
        prevUser = norm(m.content);
        break;
      }
    }
    const label = optionFirst(sub.option_label);
    rew = prevUser ? `${prevUser} — ${label}` : label;
  }

  let answer = sub.answer;
  if (grp.head.answer && rewritten) answer = `${answer}\n\n${grp.head.answer}`.trim();

  return {
    entry_id: sub.id,
    block: sub.block,
    answer,
    doc_refs: sub.doc_refs,
    contact: sub.contact || grp.head.contact,
    score: bestScore,
    rewritten_query: rew,
  };
}

/** Лучший FAQ-ответ для свободного текста или null. */
export async function matchFaq(
  query: string,
  history?: ChatMessage[] | null
): Promise<FaqHit | null> {
  const all = await groups();
  if (!all.size) return null;

  const q = norm(query);
  if (q.length < 3) return null;

  const qv = await embedOne(q.toLowerCase(), true);
  const ql = q.toLowerCase();
  const qLems = lemmas(q);

  // Общий матч по вариантам формулировок
  let bestGk: string | null = null;
  let bestScore = 0;
  for (const [gk, grp] of all) {
    for (const p of grp.phrases) {
      let score = cosine(qv, p.vec);
      const tl = p.text.toLowerCase();
      // Точное вхождение формулировки — сильный сигнал независимо от эмбеддинга
      if (tl.length >= 6 && (ql.includes(tl) || tl.includes(ql))) score = Math.max(score, 0.9);
      // Все содержательные леммы варианта названы в запросе
      else if (p.lems.size && isSubset(p.lems, qLems)) score = Math.max(score, LEMMA_BOOST);
      if (score > bestScore) {
        bestGk = gk;
        bestScore = score;
      }
    }
  }
  if (!bestGk || bestScore < GROUP_HIT) return null;

  const grp = all.get(bestGk) as Group;
  if (!grp.subs.length) {
    return {
      entry_id: grp.head.id,
      block: grp.head.block,
      answer: grp.head.answer,
      doc_refs: grp.head.doc_refs,
      contact: grp.head.contact,
      score: bestScore,
      rewritten_query: null,
    };
  }

  // Ветвящаяся группа: запрос уже называет под-ветку? Тогда точный под-ответ.
  const direct = matchOption(grp, q, qv, qLems, history, false);
  if (direct) {
    direct.score = Math.max(direct.score, bestScore);
    return direct;
  }

  // Иначе — сводный контекст из всех под-ответов (уточняющий выбор делают
  // кнопки быстрого набора на /chat; бот не перехватывает диалог вопросом,
  // LLM сама раскроет подходящие ветки в ответе).
  const parts: string[] = [];
  const docs: string[] = [];
  if (grp.head.answer) parts.push(grp.head.answer);
  for (const s of grp.subs) {
    const label = optionFirst(s.option_label);
    if (s.answer) parts.push(`${label}: ${s.answer}`);
    for (const d of s.doc_refs) if (!docs.includes(d)) docs.push(d);
  }
  return {
    entry_id: grp.head.id,
    block: grp.head.block,
    answer: parts.join('\n\n'),
    doc_refs: docs,
    contact: grp.head.contact,
    score: bestScore,
    rewritten_query: null,
  };
}
