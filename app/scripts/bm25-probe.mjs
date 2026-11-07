// Печатает токенизацию BM25 для фраз: проверка нормализации слов.
//
// Если формы приводятся к разным леммам, токены корпуса и запроса перестают
// совпадать и лексическая часть гибридного поиска молча перестаёт работать.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const az = require('az');
const dicts = path.join(path.dirname(require.resolve('az/package.json')), 'dicts');

await new Promise((resolve, reject) => {
  az.Morph.init(dicts, (err) => (err ? reject(err) : resolve()));
});

const TOKEN_RE = /\d+(?:\.\d+)+|[\wа-яёА-ЯЁ]+/gu;
const RU_STOP = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'у', 'же', 'по', 'за', 'от',
  'о', 'об', 'обо', 'из', 'изо', 'для', 'при', 'про', 'до', 'над', 'под',
  'подо', 'через', 'между', 'а', 'но', 'или', 'либо', 'что', 'как', 'так',
  'это', 'этот', 'эта', 'эти', 'этого', 'этой', 'этом', 'тот', 'та', 'те',
  'он', 'она', 'оно', 'они', 'его', 'ее', 'её', 'их', 'им', 'ему', 'ей',
  'я', 'ты', 'мы', 'вы', 'мне', 'меня', 'тебя', 'нас', 'вас', 'них', 'ним',
  'ней', 'быть', 'был', 'была', 'было', 'были', 'есть', 'бы', 'ли',
]);

function tokenize(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TOKEN_RE)) {
    const t = m[0].toLowerCase();
    if (RU_STOP.has(t)) continue;
    if (t.length < 2 && !/^\d$/.test(t)) continue;
    const parses = az.Morph(t);
    out.push(parses?.length ? parses[0].normalize().word : t);
  }
  return out;
}

const phrases = process.argv.slice(2);
process.stdout.write(JSON.stringify(phrases.map(tokenize)));
