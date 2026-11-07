// Проверяет качество лемматизации Az.js в сравнении с ожидаемыми формами.
//
// Зачем: BM25 нормализует слова и в корпусе, и в запросе. Лемматизация
// ("уволен" -> "уволить") сохраняет больше совпадений, чем стеммер, который
// просто обрезает окончания.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Az from 'az';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DICTS = path.resolve(HERE, '..', 'node_modules', 'az', 'dicts');

await new Promise((resolve, reject) => {
  Az.Morph.init(DICTS, (err) => (err ? reject(err) : resolve()));
});

// Слова из юридических текстов: слева форма из документа, справа - ожидаемая лемма.
const CASES = [
  ['работника', 'работник'],
  ['работникам', 'работник'],
  ['прогула', 'прогул'],
  ['уволен', 'уволить'],
  ['увольнения', 'увольнение'],
  ['командировки', 'командировка'],
  ['отпуска', 'отпуск'],
  ['трудовым', 'трудовой'],
  ['договором', 'договор'],
  ['предоставляется', 'предоставляться'],
  ['беременности', 'беременность'],
  ['выплачивается', 'выплачиваться'],
];

let hit = 0;
console.log(`${'форма'.padEnd(18)}${'Az.js'.padEnd(18)}${'ожидалось'.padEnd(18)}`);
console.log('-'.repeat(58));
for (const [form, expected] of CASES) {
  const parses = Az.Morph(form);
  const lemma = parses?.length ? parses[0].normalize().word : form;
  const ok = lemma === expected;
  if (ok) hit++;
  console.log(`${form.padEnd(18)}${lemma.padEnd(18)}${expected.padEnd(18)}${ok ? '+' : '—'}`);
}
console.log('-'.repeat(58));
console.log(`Совпало: ${hit} из ${CASES.length}`);
