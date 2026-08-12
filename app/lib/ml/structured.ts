import 'server-only';
import { prisma } from '@/lib/db';
import { ABBREVIATIONS } from './aliases';
import { initStemmer, tokenize } from './bm25';
import { RAG } from './config';
import { embedOne } from './embeddings';
import type { PlanUnit } from './planner';
import { search as denseSearch } from './qdrant';
import { fetchChunksByArticleNo, parseArticleNo, type RetrievedChunk } from './retriever';
import {
  fetchArticleHeads,
  fetchChunksByTextPrefix,
  fetchChunksByUnit,
  fetchDocumentChunks,
  fetchUnitHeads,
} from './store';

// Структурные режимы retrieval по плану запроса: точная статья/единица,
// первая/последняя, первые N, количество + подтяжка связанных норм.
// Порт metadata-методов RAGPipeline (services/rag/pipeline.py): _exact_*,
// _extreme_*, _range_*, _count_*, _resolve_doc_hint, _merge_article_chunks,
// _expand_with_linked_articles.

// Заголовок статьи в начале чанка: «Статья 81. …»
const ARTICLE_HEADER_RE = /^\s*стать[яеи]?\s+(\d+(?:\.\d+)?)/i;
// Маркер чанка-продолжения длинной статьи: «[Статья 81. … — продолжение] …»
const CONT_TAG_RE = /^\[[^\]]*—\s*продолжение\]\s*/i;

/** 81.0 → «81», 84.1 → «84.1» (для текстовых фолбэков и справок). */
export function fmtArticleNo(n: number): string {
  return Number.isInteger(n) ? String(Math.trunc(n)) : String(n);
}

/**
 * Склеивает чанки одной статьи (голова + «— продолжение») в ЦЕЛЬНЫЙ текст:
 * снимает маркер продолжения и срезает дублирующееся перекрытие чанкера.
 * Иначе модель видит «фрагменты» с обрывом посреди слова и отказывается
 * цитировать статью, хотя весь текст уже в контексте.
 */
export function mergeArticleChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const out: RetrievedChunk[] = [];
  for (const c of chunks) {
    const m = CONT_TAG_RE.exec(c.text || '');
    const prev = out.length ? out[out.length - 1] : null;
    if (
      m &&
      prev &&
      prev.document_id === c.document_id &&
      prev.chunk_index !== null &&
      c.chunk_index === (prev.chunk_index ?? 0) + 1
    ) {
      const cont = c.text.slice(m[0].length);
      // Перекрытие: конец головы дословно повторяется в начале продолжения
      // (chunk_overlap символов, часто с обрывом слова) — ищем стык.
      const maxOv = Math.min(prev.text.length, cont.length, RAG.chunkOverlap + 80);
      let joined: string | null = null;
      for (let k = maxOv; k > 19; k--) {
        if (prev.text.endsWith(cont.slice(0, k))) {
          joined = prev.text + cont.slice(k);
          break;
        }
      }
      prev.text = joined ?? `${prev.text}\n${cont}`;
      prev.chunk_index = c.chunk_index; // для склейки следующего продолжения
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

/**
 * Прямая выборка чанков, начинающихся со «Статья N.» — фолбэк для старых
 * данных без article_no в payload.
 *
 * Лимит сознательно небольшой: «Статья 1.» встречается во многих документах,
 * без лимита промпт раздувается до 3-4 тысяч токенов.
 */
export async function exactArticleRetrieve(articleNos: string[]): Promise<RetrievedChunk[]> {
  const out: RetrievedChunk[] = [];
  for (const n of articleNos) {
    // digitBoundary: «статья 28» не должна цеплять «Статья 280»/«28.1».
    const hits = await fetchChunksByTextPrefix(`статья ${n}`.toLowerCase(), 4, true);
    const contHits = await fetchChunksByTextPrefix(`[статья ${n}`.toLowerCase(), 4, true);
    out.push(...hits, ...contHits);
  }

  const seen = new Set<string>();
  const uniq: RetrievedChunk[] = [];
  for (const c of out) {
    const key = `${c.document_id}:${c.chunk_index}:${c.text.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  uniq.sort((a, b) => (a.document_id ?? 0) - (b.document_id ?? 0) || (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
  return mergeArticleChunks(uniq);
}

/**
 * Сканирует заголовки «Статья N» и возвращает минимальный/максимальный номер —
 * фолбэк extreme для данных без article_no.
 */
export async function findExtremeArticleNumber(kind: 'first' | 'last'): Promise<string | null> {
  const hits = await fetchChunksByTextPrefix('статья ', 10_000);
  const nums: [number, string][] = [];
  for (const h of hits) {
    const m = ARTICLE_HEADER_RE.exec(h.text || '');
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) nums.push([n, m[1]]);
  }
  if (!nums.length) return null;
  nums.sort((a, b) => a[0] - b[0]);
  return (kind === 'first' ? nums[0] : nums[nums.length - 1])[1];
}

/**
 * Голосование топ-5 dense-хитов за document_id — чтобы extreme/range/exact
 * привязывались к одному документу («последняя статья ТК», а не по всей базе).
 */
export async function pickRelevantDocument(query: string): Promise<number | null> {
  try {
    const qvec = await embedOne(query, true);
    const hits = await denseSearch(qvec, { topK: 5 });
    const votes = new Map<number, number>();
    for (const h of hits) {
      if (h.document_id === null) continue;
      votes.set(h.document_id, (votes.get(h.document_id) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestVotes = 0;
    for (const [docId, n] of votes) {
      if (n > bestVotes) {
        best = docId;
        bestVotes = n;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * «ТК»/«коллективного договора» → document_id. Аббревиатуру разворачиваем
 * через aliases, затем сопоставляем ЛЕММЫ подсказки с леммами названий:
 * SQL LIKE не понижает кириллицу и не знает падежей («коллективного договора»
 * ≠ подстрока «Коллективный договор»). Документов десятки, полный проход дёшев.
 * Совпадение — все леммы подсказки входят в леммы названия; при нескольких
 * кандидатах берём самое короткое (наиболее точное) название.
 */
export async function resolveDocHint(docHint: string | null): Promise<number | null> {
  if (!docHint) return null;
  try {
    await initStemmer();
    const hint = docHint.trim();
    const full = ABBREVIATIONS[hint.toUpperCase()] || ABBREVIATIONS[hint] || hint;
    const variants = [...new Set([hint, full])]
      .map((v) => new Set(tokenize(v)))
      .filter((v) => v.size);
    if (!variants.length) return null;

    const docs = await prisma.kb_documents.findMany({
      where: { status: 'indexed' },
      select: { id: true, title: true, source_uri: true },
    });

    let bestId: number | null = null;
    let bestExtra: number | null = null;
    for (const d of docs) {
      const titleLemmas = new Set([...tokenize(d.title || ''), ...tokenize(d.source_uri || '')]);
      if (!titleLemmas.size) continue;
      for (const cand of variants) {
        let subset = true;
        for (const t of cand) {
          if (!titleLemmas.has(t)) {
            subset = false;
            break;
          }
        }
        if (!subset) continue;
        const extra = titleLemmas.size - cand.size;
        if (bestExtra === null || extra < bestExtra) {
          bestId = d.id;
          bestExtra = extra;
        }
        break;
      }
    }
    return bestId;
  } catch {
    return null;
  }
}

/**
 * Синтетический чанк с ДЕТЕРМИНИРОВАННЫМ фактом о структуре документа.
 * Нужен, потому что в обычных выдержках нет признака «это последняя статья», и
 * системный промпт справедливо отказывается угадывать. Факт вычислен по индексу
 * (article_no/unit_ord), не галлюцинация — поэтому даём его модели как источник.
 */
function structureNote(docTitle: string, text: string): RetrievedChunk {
  return {
    text,
    score: 99.0, // всегда первым в контексте
    document_id: null,
    chunk_index: null,
    title: `Структура документа «${docTitle}» (определено системой)`,
    source_uri: 'system',
    source_type: 'system',
    priority: 2,
  };
}

// ---------------------------------------------------------------------------
// Статьи (unit = article)
// ---------------------------------------------------------------------------

async function articlesChunks(pairs: [number, number | null][]): Promise<RetrievedChunk[]> {
  const out: RetrievedChunk[] = [];
  const seen = new Set<string>();
  for (const [no, did] of pairs) {
    for (const c of await fetchChunksByArticleNo(no, did, 8)) {
      const key = `${c.document_id}:${c.chunk_index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

export async function exactArticleByMeta(
  articleNos: number[],
  documentId: number | null = null
): Promise<RetrievedChunk[]> {
  return mergeArticleChunks(await articlesChunks(articleNos.map((n) => [n, documentId])));
}

/** Только заголовок статьи (первый чанк) — для extreme/range этого достаточно. */
async function headChunk(no: number, did: number | null): Promise<RetrievedChunk | null> {
  const cs = await fetchChunksByArticleNo(no, did, 1);
  return cs.length ? cs[0] : null;
}

async function headsFor(query: string, docHint: string | null): Promise<[number, number | null][]> {
  // Документ по явной подсказке («ТК») приоритетнее семантического выбора.
  const docId = (await resolveDocHint(docHint)) ?? (await pickRelevantDocument(query));
  let heads = await fetchArticleHeads(docId);
  if (!heads.length && docId !== null) heads = await fetchArticleHeads(null); // глобальный фолбэк
  return heads;
}

/** «Первая/последняя статья»: справка о структуре + заголовок этой статьи. */
export async function extremeArticleByMeta(
  extreme: 'first' | 'last',
  query: string,
  docHint: string | null = null
): Promise<RetrievedChunk[]> {
  const heads = await headsFor(query, docHint);
  if (!heads.length) return [];
  const [firstNo, firstDoc] = heads[0];
  const [lastNo, lastDoc] = heads[heads.length - 1];
  const [targetNo, targetDoc] = extreme === 'first' ? [firstNo, firstDoc] : [lastNo, lastDoc];
  const head = await headChunk(targetNo, targetDoc);
  if (!head) return [];

  const which = extreme === 'first' ? 'первая' : 'последняя';
  const note = structureNote(
    head.title || 'документ',
    `По структуре документа определено: статьи нумеруются с ${fmtArticleNo(firstNo)} по ` +
      `${fmtArticleNo(lastNo)}. Таким образом, ${which} статья — Статья ${fmtArticleNo(targetNo)}. ` +
      'Её заголовок и начало текста приведены ниже.'
  );
  return [note, head];
}

/** «Первые/последние N статей»: справка + заголовки выбранных статей. */
export async function rangeArticlesByMeta(
  n: number,
  order: 'asc' | 'desc',
  query: string,
  docHint: string | null = null
): Promise<RetrievedChunk[]> {
  const heads = await headsFor(query, docHint);
  if (!heads.length) return [];
  const firstNo = heads[0][0];
  const lastNo = heads[heads.length - 1][0];
  const chosen = (order === 'asc' ? heads.slice(0, n) : heads.slice(-n)).sort((a, b) => a[0] - b[0]);

  const out: RetrievedChunk[] = [];
  for (const [no, did] of chosen) {
    const head = await headChunk(no, did);
    if (head) out.push(head);
  }
  if (!out.length) return [];

  const which = order === 'asc' ? 'первые' : 'последние';
  const nums = chosen.map(([no]) => fmtArticleNo(no)).join(', ');
  const note = structureNote(
    out[0].title || 'документ',
    `По структуре документа определено: статьи нумеруются с ${fmtArticleNo(firstNo)} по ` +
      `${fmtArticleNo(lastNo)}. Запрошены ${which} ${out.length} статей: ${nums}. ` +
      'Их заголовки приведены ниже.'
  );
  return [note, ...out];
}

/**
 * Богатая справка о количестве статей — чтобы модель отвечала на семейство
 * вопросов (всего / без подстатей / сколько подстатей / диапазон), а не на один
 * шаблон. Считаем по уникальным номерам заголовков.
 */
export async function countArticles(
  query: string,
  docHint: string | null = null
): Promise<RetrievedChunk[]> {
  const heads = await headsFor(query, docHint);
  if (!heads.length) return [];
  const nos = [...new Set(heads.map(([no]) => no))].sort((a, b) => a - b);
  const main = nos.filter((n) => Number.isInteger(n)); // 81, 82 …
  const sub = nos.filter((n) => !Number.isInteger(n)); // 84.1, 22.2 …
  const sample = await headChunk(nos[0], null);
  const title = sample?.title || 'документ';
  const rng = main.length
    ? `с ${fmtArticleNo(main[0])} по ${fmtArticleNo(main[main.length - 1])}`
    : `с ${fmtArticleNo(nos[0])} по ${fmtArticleNo(nos[nos.length - 1])}`;

  return [
    structureNote(
      title,
      'По структуре документа определено (по заголовкам «Статья N»):\n' +
        `- всего пронумерованных статей: ${nos.length};\n` +
        `- основных статей (целые номера, ${rng}): ${main.length};\n` +
        `- дополнительных статей-подстатей (вида 84.1, 22.2): ${sub.length}.\n` +
        'Используй эти числа: «сколько всего» = всего; «без подстатей»/«основных» = ' +
        'основных; «сколько подстатей» = дополнительных.'
    ),
  ];
}

// ---------------------------------------------------------------------------
// Обобщённая навигация по единицам (раздел/глава/пункт/§) — не «Статья»
// ---------------------------------------------------------------------------
// (первый_прил, последний_прил, именительный ед.ч., родительный мн.ч.)
const UNIT_WORDS: Record<string, [string, string, string, string]> = {
  article: ['первая', 'последняя', 'статья', 'статей'],
  section: ['первый', 'последний', 'раздел', 'разделов'],
  chapter: ['первая', 'последняя', 'глава', 'глав'],
  clause: ['первый', 'последний', 'пункт', 'пунктов'],
  paragraph: ['первый', 'последний', 'параграф', 'параграфов'],
};

function unitWords(unit: string): [string, string, string, string] {
  return UNIT_WORDS[unit] ?? ['первый', 'последний', unit, unit];
}

async function unitHeadsFor(
  unit: PlanUnit,
  query: string,
  docHint: string | null
): Promise<[string, number, number | null][]> {
  const docId = (await resolveDocHint(docHint)) ?? (await pickRelevantDocument(query));
  let heads = await fetchUnitHeads(unit, docId);
  if (!heads.length && docId !== null) heads = await fetchUnitHeads(unit, null);
  return heads;
}

export async function exactUnitsByMeta(
  unit: PlanUnit,
  nos: number[],
  documentId: number | null = null
): Promise<RetrievedChunk[]> {
  const out: RetrievedChunk[] = [];
  const seen = new Set<string>();
  for (const n of nos) {
    for (const c of await fetchChunksByUnit(unit, fmtArticleNo(n), documentId, 8)) {
      const key = `${c.document_id}:${c.chunk_index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

export async function extremeUnitByMeta(
  unit: PlanUnit,
  extreme: 'first' | 'last',
  query: string,
  docHint: string | null = null
): Promise<RetrievedChunk[]> {
  const heads = await unitHeadsFor(unit, query, docHint);
  if (!heads.length) return [];
  const [noStr, , doc] = extreme === 'first' ? heads[0] : heads[heads.length - 1];
  const cs = await fetchChunksByUnit(unit, noStr, doc, 1);
  if (!cs.length) return [];
  const head = cs[0];

  const [firstAdj, lastAdj, noun] = unitWords(unit);
  const which = extreme === 'first' ? firstAdj : lastAdj;
  const capNoun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const note = structureNote(
    head.title || 'документ',
    `По структуре документа определено: единицы «${noun}» нумеруются с ${heads[0][0]} по ` +
      `${heads[heads.length - 1][0]}. Таким образом, ${which} ${noun} — ${capNoun} ${noStr}. ` +
      'Заголовок приведён ниже.'
  );
  return [note, head];
}

export async function rangeUnitsByMeta(
  unit: PlanUnit,
  n: number,
  order: 'asc' | 'desc',
  query: string,
  docHint: string | null = null
): Promise<RetrievedChunk[]> {
  const heads = await unitHeadsFor(unit, query, docHint);
  if (!heads.length) return [];
  const chosen = (order === 'asc' ? heads.slice(0, n) : heads.slice(-n)).sort((a, b) => a[1] - b[1]);

  const out: RetrievedChunk[] = [];
  for (const [noStr, , doc] of chosen) {
    const cs = await fetchChunksByUnit(unit, noStr, doc, 1);
    if (cs.length) out.push(cs[0]);
  }
  if (!out.length) return [];

  const gen = unitWords(unit)[3];
  const which = order === 'asc' ? 'первые' : 'последние';
  const nums = chosen.map(([noStr]) => noStr).join(', ');
  const note = structureNote(
    out[0].title || 'документ',
    `Запрошены ${which} ${out.length} ${gen}: ${nums}. Заголовки приведены ниже.`
  );
  return [note, ...out];
}

export async function countUnits(
  unit: PlanUnit,
  query: string,
  docHint: string | null = null
): Promise<RetrievedChunk[]> {
  const heads = await unitHeadsFor(unit, query, docHint);
  if (!heads.length) return [];
  const distinct = new Set(heads.map(([noStr]) => noStr)).size;
  const gen = unitWords(unit)[3];
  const cs = await fetchChunksByUnit(unit, heads[0][0], heads[0][2], 1);
  const title = cs.length ? cs[0].title || 'документ' : 'документ';
  return [
    structureNote(
      title,
      `По структуре документа определено: всего ${gen} — ${distinct} ` +
        `(нумерация с ${heads[0][0]} по ${heads[heads.length - 1][0]}).`
    ),
  ];
}

/**
 * Каталожный фолбэк range: находим самый релевантный документ и отдаём его
 * первые/последние N чанков в порядке chunk_index.
 */
export async function listQueryRetrieve(
  query: string,
  n: number,
  order: 'asc' | 'desc'
): Promise<RetrievedChunk[]> {
  try {
    const docId = await pickRelevantDocument(query);
    if (docId === null) return [];
    return await fetchDocumentChunks(docId, n, order);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Граф ссылок kb_links (порт _expand_with_linked_articles)
// ---------------------------------------------------------------------------

/**
 * По графу kb_links добираем статьи, на которые ссылаются найденные чанки.
 * Помогает на вопросах вида «расскажи про ст. 81» — модель получает не только
 * саму ст. 81, но и ст. 192, на которую она ссылается.
 */
export async function expandWithLinkedArticles(
  chunks: RetrievedChunk[],
  maxExtra = 3
): Promise<RetrievedChunk[]> {
  if (!chunks.length) return chunks;
  try {
    const sourceDocIds = [...new Set(chunks.map((c) => c.document_id).filter((d): d is number => d !== null))];
    const sourceChunkIdx = [...new Set(chunks.map((c) => c.chunk_index).filter((i): i is number => i !== null))];
    if (!sourceDocIds.length) return chunks;

    const links = await prisma.kb_links.findMany({
      where: {
        from_doc_id: { in: sourceDocIds },
        from_chunk_index: { in: sourceChunkIdx },
        target_kind: 'article',
      },
      take: maxExtra * 3,
    });
    if (!links.length) return chunks;

    // Номера УЖЕ найденных статей: ссылка «на себя» (заголовок статьи в старых
    // kb_links) не должна подтягивать чужие статьи через префикс.
    const sourceNos = new Set(
      chunks.map((c) => parseArticleNo(c.text)).filter((n): n is number => n !== null)
    );

    const extra: RetrievedChunk[] = [];
    const already = new Set(chunks.map((c) => `${c.document_id}:${c.chunk_index}`));
    const seenArticles = new Set<string>();

    for (const link of links) {
      if (seenArticles.has(link.target_number)) continue;
      const asNumber = Number(link.target_number);
      if (Number.isFinite(asNumber) && sourceNos.has(asNumber)) continue; // самоссылка
      seenArticles.add(link.target_number);

      for (const gRaw of await exactArticleRetrieve([link.target_number])) {
        const key = `${gRaw.document_id}:${gRaw.chunk_index}`;
        if (already.has(key)) continue;
        extra.push({ ...gRaw, score: gRaw.score * 0.9 }); // связанные слегка ниже основных
        already.add(key);
      }
      if (extra.length >= maxExtra) break;
    }
    return extra.length ? [...chunks, ...extra.slice(0, maxExtra)] : chunks;
  } catch {
    return chunks;
  }
}
