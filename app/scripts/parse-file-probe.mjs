// Прогоняет реальные документы через lib/parsers (parseFile) и печатает, что
// извлеклось: длину текста, метаданные и первые строки.
//
// Зачем: parseFile - единственная точка, где Next зависит от внешних программ
// (Tesseract для OCR, LibreOffice для .doc/.xls/.ppt/.odt). Проверять её через
// приложение долго, а тут видно и текст, и время разбора каждого файла.
//
// Запуск (по умолчанию берёт весь backend/docs/local):
//   node scripts/parse-file-probe.mjs
//   node scripts/parse-file-probe.mjs "../backend/docs/local/файл.pdf" ...
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOCS = path.resolve(ROOT, '..', 'backend', 'docs', 'local');

// Модули приложения - TypeScript со "бандлерными" импортами (без расширений,
// алиас @/ и маркер server-only). Node умеет исполнять .ts, но разрешать такие
// специфкаторы - нет, поэтому добавляем те же правила, что применяет Next.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export{}', shortCircuit: true };
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);

    let target = null;
    if (specifier.startsWith('@/')) target = path.join(ROOT, specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (target && !path.extname(target)) {
      for (const c of [`${target}.ts`, `${target}.tsx`, path.join(target, 'index.ts')]) {
        if (existsSync(c)) return { url: pathToFileURL(c).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { parseFile } = await import('../lib/parsers/index.ts');

const args = process.argv.slice(2);
const files = args.length
  ? args.map((f) => path.resolve(f))
  : (await readdir(DOCS)).map((n) => path.join(DOCS, n));

let ok = 0;
let failed = 0;
for (const file of files) {
  const name = path.basename(file);
  const started = Date.now();
  try {
    const { text, meta } = await parseFile(file);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 110);
    const extra = JSON.stringify(meta.extra);
    console.log(
      `${text.trim() ? '+' : '—'} ${name}\n` +
        `    ${text.length} симв. за ${secs} с | страниц: ${meta.pages} | ` +
        `title: ${JSON.stringify(meta.title)} | mime: ${meta.mime_type} | extra: ${extra}\n` +
        `    ${preview}${preview.length === 110 ? '…' : ''}`
    );
    if (text.trim()) ok += 1;
    else failed += 1;
  } catch (e) {
    console.log(`! ${name}\n    ОШИБКА: ${e instanceof Error ? e.message : e}`);
    failed += 1;
  }
}
console.log(`\nРазобрано с текстом: ${ok}, пусто/ошибка: ${failed}, всего: ${files.length}`);
