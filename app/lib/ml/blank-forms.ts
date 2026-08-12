import 'server-only';
import { prisma } from '@/lib/db';
import { initStemmer, lemma } from './bm25';

// Резолвер «связанных документов» FAQ → реальные скачиваемые файлы (А2/А3).
// Порт services/rag/blank_forms.py с доработками поверх него:
//
// FAQ-таблицы называют документы свободным текстом («Заявление об увольнении»,
// «Порядок аттестации…»). Здесь сопоставляем эти названия с реальными
// шаблонами (doc_templates — бланки заявлений) и документами базы знаний,
// чтобы бот отдавал кликабельные карточки «Скачать/Открыть», а не текст.
//
// Матчинг — по пересечению значимых ЛЕММ (Jaccard), локально, без LLM; та же
// морфология, что и в BM25 (Az.js на словарях OpenCorpora), поэтому
// «командировки» ≈ «командировках», «дети» ≈ «ребёнком». Порог консервативный:
// лучше не показать карточку, чем подсунуть чужой файл. Ссылка с URL становится
// карточкой-переходом на страницу сайта, а не ищется среди файлов.

const WORD_RE = /[а-яёa-z0-9]+/gi;
const URL_RE = /https?:\/\/[^\s)»«]+/i;
const STOP = new Set([
  'и', 'или', 'для', 'на', 'по', 'об', 'от', 'при', 'из', 'до', 'к', 'во',
  'the', 'a', 'of', 'тиу', 'файл', 'приложен', 'приложены', 'шаблон', 'бланк',
  'пример', 'примеры', 'образец', 'образцы', 'скачать',
]);
// Порог совпадения (Jaccard значимых лемм). ≥0.5 отсекает «отпуск≈отпуск» ложняки.
const HIT = 0.5;

// Стоп-слова проверяются и по словоформе, и по лемме: список выше составлен
// в словоформах («примеры»), а токены после нормализации — леммы («пример»).
function tokens(s: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of String(s || '').matchAll(WORD_RE)) {
    const w = m[0].toLowerCase();
    if (w.length < 3 || STOP.has(w)) continue;
    const l = lemma(w);
    if (!STOP.has(l)) out.add(l);
  }
  return out;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function score(rt: Set<string>, ct: Set<string>): number {
  if (!rt.size || !ct.size) return 0;
  const inter = intersectionSize(rt, ct);
  if (!inter) return 0;
  const union = rt.size + ct.size - inter;
  let jac = inter / union;
  if (inter === rt.size) {
    // Все значимые слова ссылки содержатся в названии кандидата. Для ссылки из
    // 2+ слов это уверенное совпадение; одному слову («Программа») уверенности
    // не хватает — раньше правило давало 0.8 и «Программа» превращалась в
    // «Социальную программу университета» (жалоба HR). Теперь одиночное слово
    // получает ровно порог: неоднозначность решают жаккар и приоритет бланков.
    jac = Math.max(jac, rt.size >= 2 ? 0.8 : HIT);
  }
  return jac;
}

export interface RelatedFile {
  title: string;
  kind: 'template' | 'document' | 'link';
  url: string;
  view_url: string;
}

interface CatalogItem extends RelatedFile {
  toks: Set<string>;
  // Леммы имени исходного файла (extra.filename): FAQ нередко ссылается на
  // документ по имени файла, а название в БЗ выведено из его шапки.
  fileToks: Set<string> | null;
}

// Каталог живёт в памяти процесса и перечитывается после (пере)индексации.
const g = globalThis as unknown as { __hrBlankCatalog?: Promise<CatalogItem[]> };

async function load(): Promise<CatalogItem[]> {
  await initStemmer(); // токены — леммы той же морфологии, что и BM25/FAQ
  const [templates, documents] = await Promise.all([
    prisma.doc_templates.findMany({ where: { is_enabled: true }, select: { id: true, title: true } }),
    prisma.kb_documents.findMany({
      where: { status: 'indexed' },
      select: { id: true, title: true, extra: true },
    }),
  ]);

  const items: CatalogItem[] = [];
  for (const t of templates) {
    items.push({
      title: t.title,
      toks: tokens(t.title),
      fileToks: null,
      kind: 'template',
      url: `/api/kb/templates/${t.id}/download`,
      view_url: `/kb/templates/${t.id}/view`,
    });
  }
  for (const d of documents) {
    const extra = d.extra && typeof d.extra === 'object' && !Array.isArray(d.extra)
      ? (d.extra as Record<string, unknown>)
      : null;
    const filename = typeof extra?.filename === 'string' ? extra.filename : '';
    const fileToks = filename ? tokens(filename.replace(/\.[a-z0-9]+$/i, '')) : null;
    items.push({
      title: d.title,
      toks: tokens(d.title),
      fileToks: fileToks?.size ? fileToks : null,
      kind: 'document',
      url: `/api/kb/documents/${d.id}/download`,
      view_url: `/kb/documents/${d.id}/view`,
    });
  }
  return items;
}

function catalog(): Promise<CatalogItem[]> {
  if (!g.__hrBlankCatalog) {
    g.__hrBlankCatalog = load().catch((e) => {
      g.__hrBlankCatalog = undefined;
      throw e;
    });
  }
  return g.__hrBlankCatalog;
}

/** Каталог устарел (индексация/удаление документа) — перечитать при след. запросе. */
export function invalidateBlankCatalog(): void {
  g.__hrBlankCatalog = undefined;
}

/** [{title, kind: template|document|link, url, view_url}] для распознанных ссылок. */
export async function resolveDocRefs(docRefs: string[] | null | undefined): Promise<RelatedFile[]> {
  try {
    // Морфология обязана быть готова ДО токенизации ссылок: каталог мог быть
    // прогрет другим экземпляром модуля (dev-перезагрузка), и тогда load() не
    // вызовется, а lemma() без инициализации вернёт словоформы — токены ссылок
    // перестанут совпадать с леммами каталога.
    await initStemmer();
    const items = await catalog();
    const out: RelatedFile[] = [];
    const seen = new Set<string>();

    for (const ref of docRefs || []) {
      const text = String(ref || '');

      // Ссылка с URL — карточка-переход на страницу сайта: искать её среди
      // файлов бессмысленно (адрес не совпадёт со словами названия никогда).
      const urlMatch = URL_RE.exec(text);
      if (urlMatch) {
        const url = urlMatch[0].replace(/[.,;:]+$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        const label = text
          .replace(urlMatch[0], '')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/[—–:-]\s*$/, '')
          .trim();
        out.push({
          title: label || url.replace(/^https?:\/\//i, ''),
          kind: 'link',
          url: '', // скачивать нечего — только переход
          view_url: url,
        });
        continue;
      }

      const rt = tokens(text);
      if (!rt.size) continue;
      let best: CatalogItem | null = null;
      let bestScore = 0;
      for (const it of items) {
        // Название документа ИЛИ имя исходного файла — что совпало сильнее.
        const sc = Math.max(score(rt, it.toks), it.fileToks ? score(rt, it.fileToks) : 0);
        // При равном счёте: сначала шаблон-бланк, затем более специфичное
        // название (меньше слов, не покрытых ссылкой): «Программа» должна
        // выбирать «Программу стажировки», а не длинное «Заявление … по
        // социальной программе», у которого тот же балл из-за одиночного слова.
        const better =
          sc > bestScore ||
          (sc === bestScore &&
            best !== null &&
            (it.kind === 'template' && best.kind !== 'template'
              ? true
              : it.kind === best.kind && it.toks.size < best.toks.size));
        if (better) {
          best = it;
          bestScore = sc;
        }
      }
      if (best && bestScore >= HIT && !seen.has(best.url)) {
        seen.add(best.url);
        out.push({
          title: text.trim() || best.title,
          kind: best.kind,
          url: best.url,
          view_url: best.view_url,
        });
      }
    }
    return out;
  } catch {
    return []; // резолв не удался — карточки просто не покажем
  }
}

// Служебные слова запроса, не различающие конкретный бланк («дай бланк заявления …»).
const GENERIC = new Set([
  'заявление', 'заявления', 'заявлений', 'бланк', 'бланка', 'бланки', 'образец',
  'образца', 'образцы', 'шаблон', 'шаблона', 'форма', 'формы', 'форму', 'документ',
  'документа', 'документы', 'выдай', 'дай', 'дать', 'нужно', 'нужен', 'нужна',
  'скачать', 'служебная', 'служебной', 'записка', 'записку', 'получить', 'хочу',
  'пришлите', 'пришли', 'предоставить', 'предоставьте', 'где', 'взять',
]);

/**
 * Из карточек-бланков оставляет те, чьи названия содержат ОТЛИЧИТЕЛЬНЫЕ (не
 * служебные) слова запроса. «дай бланк заявления о переносе отпуска» → только
 * «Заявление о переносе отпуска». Нет совпадений — возвращаем все (как было).
 */
export function narrowByQuery(query: string, files: RelatedFile[]): RelatedFile[] {
  const qt = new Set([...tokens(query)].filter((t) => !GENERIC.has(t)));
  if (!qt.size || !files.length) return files;
  const scored = files.map((f) => ({ hits: intersectionSize(qt, tokens(f.title)), file: f }));
  const best = scored.reduce((m, s) => Math.max(m, s.hits), 0);
  if (best <= 0) return files;
  return scored.filter((s) => s.hits === best).map((s) => s.file);
}
