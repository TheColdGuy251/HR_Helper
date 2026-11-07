// Диагностика надстроек RAG: по каждому запросу печатает, что сработало -
// spellfix, намерение, semantic-router, режим планировщика, FAQ, бланки и что
// в итоге нашёл поиск.
//
// Использование:
//   node scripts/rag-probe.mjs                      - набор запросов по умолчанию
//   node scripts/rag-probe.mjs "свой запрос" "ещё"  - произвольные запросы
//
// Модули lib/ml - TypeScript с алиасом "@/", поэтому грузим их через jiti
// (он же разрешает "server-only", который вне сборки Next не резолвится).
// Нужны поднятые Qdrant и PostgreSQL; без LLM скрипт тоже работает - просто
// планировщик и классификатор откатятся на регэксп-гейты, о чём будет сказано.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': ROOT,
    'server-only': path.join(ROOT, 'node_modules/next/dist/compiled/server-only/empty.js'),
  },
});

const load = (rel) => jiti.import(path.join(ROOT, 'lib/ml', rel));

const QUERIES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'что написано в статье 81',
      'сколько статей в положении',
      'дай бланк заявления на отпуск',
      'пиривет',
    ];

const [
  { correctTypos },
  { resolveIntent, isStructural, routerScores },
  { needsPlanner, planQuery },
  { matchFaq },
  { resolveDocRefs, narrowByQuery },
  { retrieve },
  { isLlmAvailable },
  { RAG },
] = await Promise.all([
  load('spellfix.ts'),
  load('intent.ts'),
  load('planner.ts'),
  load('faq.ts'),
  load('blank-forms.ts'),
  load('pipeline.ts'),
  load('llm.ts'),
  load('config.ts'),
]);

// Тот же триггер "выдай бланк", что в pipeline.ts (там он приватный).
const BLANK_RE =
  /(?:(?<![0-9A-Za-zА-Яа-яЁё_])(?=[0-9A-Za-zА-Яа-яЁё_])|(?<=[0-9A-Za-zА-Яа-яЁё_])(?![0-9A-Za-zА-Яа-яЁё_]))(бланк\w*|образ(?:ец|цы|ца|цов)|шаблон\w*)|(выдай|дай|дать|нужн\w+|скачать|пришл\w+|предостав\w+|получить|хочу)[^.]{0,40}(заявлени\w*|записк\w*|форм\w*|документ\w*)/iu;

const line = (s = '') => console.log(s);
const cut = (s, n = 90) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

const llmUp = await isLlmAvailable();
line('='.repeat(78));
line(`LLM доступна: ${llmUp ? 'да' : 'НЕТ (планировщик и intent-LLM отключаются)'}`);
line(
  `Флаги: hyde=${RAG.useHyde} decompose=${RAG.useDecomposition} topics=${RAG.useTopicClassify} ` +
    `router=${RAG.useSemanticRouter}(${RAG.routerThreshold}) selfCheck=${RAG.useSelfCheck}`
);

for (const query of QUERIES) {
  line();
  line('='.repeat(78));
  line(`ЗАПРОС: «${query}»`);

  const routed = await correctTypos(query);
  line(`  spellfix   : ${routed === query ? '— (без правок)' : `«${routed}»`}`);

  const intent = await resolveIntent(routed, []);
  line(`  намерение  : ${intent ?? 'null (решают регэксп-гейты)'}`);

  const [structScore, semScore] = await routerScores(routed).catch(() => [NaN, NaN]);
  line(
    `  роутер     : needsPlanner=${needsPlanner(routed)} ` +
      `structural=${await isStructural(routed)} ` +
      `(struct=${structScore.toFixed(3)} semantic=${semScore.toFixed(3)})`
  );

  const plan = await planQuery(routed, '');
  line(
    `  планировщик: mode=${plan.mode} unit=${plan.unit} nos=[${plan.article_nos}] ` +
      `extreme=${plan.extreme} range_n=${plan.range_n}/${plan.range_order} ` +
      `doc_hint=${plan.doc_hint} search_text=«${cut(plan.search_text, 50)}»`
  );

  const faq = await matchFaq(routed, []).catch((e) => {
    line(`  FAQ        : ошибка ${e.message}`);
    return null;
  });
  line(
    faq
      ? `  FAQ        : «${faq.block}» score=${faq.score.toFixed(2)} doc_refs=${faq.doc_refs.length}`
      : '  FAQ        : нет совпадения'
  );

  if (BLANK_RE.test(routed)) {
    const files = faq ? await resolveDocRefs(faq.doc_refs) : [];
    const narrowed = narrowByQuery(query, files);
    line(`  бланки     : запрос распознан; карточек ${files.length} → после сужения ${narrowed.length}`);
    for (const f of narrowed) line(`               • [${f.kind}] ${f.title} → ${f.url}`);
  }

  const t = Date.now();
  const [chunks, subqueries] = await retrieve(routed).catch((e) => {
    line(`  ПОИСК      : ошибка ${e.message}`);
    return [[], []];
  });
  line(`  подзапросы : ${subqueries.length ? subqueries.map((s) => `«${cut(s, 40)}»`).join(', ') : '—'}`);
  line(`  найдено    : ${chunks.length} чанк(ов) за ${((Date.now() - t) / 1000).toFixed(1)} с`);
  for (const c of chunks.slice(0, 5)) {
    line(`               • ${cut(c.title, 55)} [doc=${c.document_id} idx=${c.chunk_index}]`);
    line(`                 ${cut(c.text, 110)}…`);
  }
}

line();
line('='.repeat(78));
process.exit(0);
