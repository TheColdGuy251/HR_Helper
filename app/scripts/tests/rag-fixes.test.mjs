// Тесты фиксов по итогам большого прогона RAG-пайплайна:
// 1) детект "битого начала" ответа (обрезка/протечка промпта);
// 2) регэксп-оверрайд плана поиска (пункт N / сколько разделов / последний пункт).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': ROOT,
    'server-only': path.join(ROOT, 'node_modules/next/dist/compiled/server-only/empty.js'),
  },
});
const load = (rel) => jiti.import(path.join(ROOT, rel));

// 1. looksBrokenStart

test('битое начало: строчная буква, знак препинания, протечка промпта', async () => {
  const { looksBrokenStart } = await load('lib/ml/pipeline.ts');

  // Реальные примеры брака из прогона
  assert.ok(looksBrokenStart('восные виды наград в Тюменском индустриальном…'));
  assert.ok(looksBrokenStart('о оформить командировку, необходимо…'));
  assert.ok(looksBrokenStart('."Для оформления заявления…'));
  assert.ok(looksBrokenStart(', на территории кампуса Университета…'));
  assert.ok(looksBrokenStart('числа, даты, суммы, фамилии и цитаты, которых нет в выдержках…'));
  // Протечка промпта с заглавной буквы
  assert.ok(looksBrokenStart('Не выдумывайте номера статей, даты, суммы…'));
  assert.ok(looksBrokenStart('Отказ уместен ТОЛЬКО когда в выдержках…'));

  // Прямые кавычки в начале - мусор генерации (русский текст цитирует "ёлочками")
  assert.ok(looksBrokenStart('"Пункт 1.5 Положения о наградах предусматривает…'));
  assert.ok(looksBrokenStart("'Обязанности по охране труда…"));
  // Закрывающая ёлочка в начале - тоже мусор; открывающая " - легитимная цитата
  assert.ok(looksBrokenStart('» Поддержка молодых НПР осуществляется…'));
  assert.ok(!looksBrokenStart('«Педагог года» — ежегодный конкурс…'));

  // Легитимные начала
  assert.ok(!looksBrokenStart('В университете предусмотрены следующие виды наград…'));
  assert.ok(!looksBrokenStart('**Сходства** — оба вида наград…'));
  assert.ok(!looksBrokenStart('«Ветеран труда» присваивается…'));
  assert.ok(!looksBrokenStart('1. Оформление служебной записки…'));
  assert.ok(!looksBrokenStart('По коллективному договору отпуск составляет 28 дней…'));
  assert.ok(!looksBrokenStart('⚠️ База знаний временно недоступна'));
  assert.ok(!looksBrokenStart(''));
});

// 3. looksImperativeDocCommand (гейт добора полей)

test('императивная команда на документ vs вопрос vs бланк', async () => {
  const { looksImperativeDocCommand } = await load('lib/docs/intent.ts');

  // Команды - должны запускать добор даже без извлечённых полей
  assert.ok(looksImperativeDocCommand('сделай заявление о выходе из отпуска'));
  assert.ok(looksImperativeDocCommand('оформи заявление на отпуск по беременности и родам'));
  assert.ok(looksImperativeDocCommand('подготовь приказ о приёме на работу'));

  // Вопросы о процедуре - не команды
  assert.ok(!looksImperativeDocCommand('как оформить заявление на отпуск?'));
  assert.ok(!looksImperativeDocCommand('какие документы нужно составить для командировки?'));
  assert.ok(!looksImperativeDocCommand('нужно ли оформлять заявление о переносе отпуска?'));

  // Просьбы бланка - обслуживает бланк-ветка
  assert.ok(!looksImperativeDocCommand('сделай мне бланк заявления об увольнении'));
  assert.ok(!looksImperativeDocCommand('дай образец заявления'));
});

// 2. overridePlanWithRegex

const SEMANTIC = {
  mode: 'semantic', unit: 'article', article_nos: [], extreme: null,
  range_n: null, range_order: 'asc', doc_hint: null, search_text: 'q',
};

test('оверрайд: «пункт 6.1» из semantic становится exact с unit=clause', async () => {
  const { overridePlanWithRegex } = await load('lib/ml/planner.ts');
  const p = overridePlanWithRegex({ ...SEMANTIC }, 'Что говорится в пункте 6.1 положения о командировках?');
  assert.equal(p.mode, 'exact_article');
  assert.equal(p.unit, 'clause');
  assert.deepEqual(p.article_nos, [6.1]);
});

test('оверрайд: чинит unit у структурного плана (LLM ставит article)', async () => {
  const { overridePlanWithRegex } = await load('lib/ml/planner.ts');
  const llmPlan = { ...SEMANTIC, mode: 'exact_article', unit: 'article', article_nos: [6.1] };
  const p = overridePlanWithRegex(llmPlan, 'процитируй пункт 6.1 положения о командировках');
  assert.equal(p.mode, 'exact_article');
  assert.equal(p.unit, 'clause', 'слово «пункт» в запросе должно поправить unit');
  assert.deepEqual(p.article_nos, [6.1]);
});

test('оверрайд: «сколько разделов/пунктов» → count с правильным unit', async () => {
  const { overridePlanWithRegex } = await load('lib/ml/planner.ts');
  const s = overridePlanWithRegex({ ...SEMANTIC }, 'сколько разделов в коллективном договоре?');
  assert.equal(s.mode, 'count');
  assert.equal(s.unit, 'section');
  const c = overridePlanWithRegex({ ...SEMANTIC }, 'Сколько пунктов в положении о наградах?');
  assert.equal(c.mode, 'count');
  assert.equal(c.unit, 'clause');
});

test('оверрайд: «последний пункт» → extreme last, «первый раздел» → extreme first', async () => {
  const { overridePlanWithRegex } = await load('lib/ml/planner.ts');
  const last = overridePlanWithRegex({ ...SEMANTIC }, 'какой последний пункт положения о командировках?');
  assert.equal(last.mode, 'extreme');
  assert.equal(last.extreme, 'last');
  assert.equal(last.unit, 'clause');
  assert.equal(last.range_order, 'desc');
  const first = overridePlanWithRegex({ ...SEMANTIC }, 'какой первый раздел порядка ДПО?');
  assert.equal(first.mode, 'extreme');
  assert.equal(first.extreme, 'first');
  assert.equal(first.unit, 'section');
});

test('оверрайд: «пункты с 1 по 3» → exact с перечнем номеров', async () => {
  const { overridePlanWithRegex } = await load('lib/ml/planner.ts');
  const p = overridePlanWithRegex({ ...SEMANTIC }, 'покажи пункты с 1 по 3 положения о наградах');
  assert.equal(p.mode, 'exact_article');
  assert.equal(p.unit, 'clause');
  assert.deepEqual(p.article_nos, [1, 2, 3]);
  // Слишком широкий или нецелочисленный диапазон не разворачиваем
  const wide = overridePlanWithRegex({ ...SEMANTIC }, 'покажи разделы с 1 по 50');
  assert.notEqual(wide.mode, 'exact_article');
});

test('оверрайд: обычный смысловой вопрос не трогаем', async () => {
  const { overridePlanWithRegex } = await load('lib/ml/planner.ts');
  for (const q of [
    'Какие виды наград есть в университете?',
    'Как оформить командировку?',
    'Какие социальные гарантии предусмотрены коллективным договором?',
  ]) {
    const p = overridePlanWithRegex({ ...SEMANTIC }, q);
    assert.equal(p.mode, 'semantic', q);
  }
});

test('оверрайд: многоуровневый номер «2.1.3» не ломает план', async () => {
  const { overridePlanWithRegex } = await load('lib/ml/planner.ts');
  const p = overridePlanWithRegex({ ...SEMANTIC }, 'что в пункте 2.1.3 положения?');
  // Number('2.1.3') невалиден; допустимо остаться semantic либо поймать "2.1"
  // (граница \b после (\d+(\.\d+)?) не даст захватить хвост ".3" - проверяем,
  // что не получили мусор).
  if (p.mode === 'exact_article') {
    assert.ok(p.article_nos.every((n) => Number.isFinite(n)));
  } else {
    assert.equal(p.mode, 'semantic');
  }
});

test('оверрайд: валидный не-semantic план модели сохраняет mode', async () => {
  const { overridePlanWithRegex } = await load('lib/ml/planner.ts');
  const cmp = { ...SEMANTIC, mode: 'compare' };
  const p = overridePlanWithRegex(cmp, 'сравни раздел 2 и раздел 3');
  assert.equal(p.mode, 'compare', 'mode не переопределяется');
  assert.equal(p.unit, 'section', 'а unit — чинится');
});
