// Прогоняет реальные схемы процессов через lib/docs/processes и
// печатает по каждому файлу: формат, число узлов/связей/ролей и длину SVG.
//
// Зачем: эндпоинт /api/documents/process/render детерминированный, поэтому
// его вывод можно сверять с эталоном - каталогом, куда положены
// "<имя файла без расширения>.svg".
//
// Запуск (по умолчанию - все примеры из backend/ИИ чат-бот/процессы):
//   node scripts/process-render-probe.mjs
//   node scripts/process-render-probe.mjs --ref=C:\путь\к\эталонным\svg
//   node scripts/process-render-probe.mjs "..\backend\...\процесс ДПО.xlsx"
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAMPLES = path.resolve(ROOT, '..', 'backend', 'ИИ чат-бот', 'процессы');

// Те же правила разрешения модулей, что применяет Next (алиас @/, server-only).
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

const { extractProcessGraph, renderProcessSvg } = await import('../lib/docs/processes.ts');

const args = process.argv.slice(2);
const refDir = args.find((a) => a.startsWith('--ref='))?.slice(6) ?? null;
const picked = args.filter((a) => !a.startsWith('--'));
const files = picked.length
  ? picked.map((f) => path.resolve(f))
  : (await readdir(SAMPLES, { withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => path.join(SAMPLES, d.name))
      .sort((a, b) => a.localeCompare(b, 'ru'));

// Тот же fallback заголовка, что в app/api/documents/process/render/route.ts.
function fallbackTitle(file) {
  const stem = path
    .basename(file, path.extname(file))
    .replace(/^[!_ ]+/, '')
    .replace(/\s*ИИ\s*$/, '')
    .trim();
  const chars = Array.from(stem);
  return chars.length ? chars[0].toUpperCase() + chars.slice(1).join('') : null;
}

let same = 0;
let diff = 0;
for (const file of files) {
  const name = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  try {
    const graph = await extractProcessGraph(file);
    if (!graph) {
      console.log(`— ${name}\n    ${ext} | схема не распознана (эндпоинт вернёт 422)`);
      continue;
    }
    if (!graph.title) graph.title = fallbackTitle(file);
    const svg = renderProcessSvg(graph);
    const roles = graph.nodes.filter((n) => n.role).length;
    console.log(
      `+ ${name}\n` +
        `    ${ext} | узлов: ${graph.nodes.length} | связей: ${graph.edges.length} | ` +
        `ролей: ${roles} | SVG: ${svg.length} симв.\n` +
        `    заголовок: ${JSON.stringify(graph.title)}`
    );

    if (refDir) {
      const ref = path.join(refDir, `${path.basename(file, path.extname(file))}.svg`);
      if (!existsSync(ref)) {
        console.log('    эталон: нет файла');
      } else {
        const expected = await readFile(ref, 'utf8');
        if (expected === svg) {
          console.log('    эталон: SVG совпадает байт в байт');
          same += 1;
        } else {
          const at = [...expected].findIndex((c, i) => c !== svg[i]);
          console.log(
            `    эталон: РАСХОЖДЕНИЕ (${expected.length} против ${svg.length}), с позиции ${at}\n` +
              `      py: ${expected.slice(at, at + 90)}\n` +
              `      ts: ${svg.slice(at, at + 90)}`
          );
          diff += 1;
        }
      }
    }
  } catch (e) {
    console.log(`! ${name}\n    ОШИБКА: ${e instanceof Error ? e.stack : e}`);
    diff += 1;
  }
}
if (refDir) console.log(`\nСовпало с эталоном: ${same}, разошлось: ${diff}, всего: ${files.length}`);
