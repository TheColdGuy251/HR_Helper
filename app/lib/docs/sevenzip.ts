import 'server-only';
import type { ZipEntry } from './zip';

/**
 * Чтение 7z-архива инструкций (Б7) тем же интерфейсом, что и ZIP.
 * Отдел охраны труда жмёт инструкции 7-Zip'ом — по отзыву УРП от 21.07 их
 * архив «охрана труда.7z» инструмент дедупликации не принимал вовсе.
 *
 * Распаковывает 7z-wasm (официальный 7-Zip, собранный в WebAssembly): без
 * внешних бинарей, работает и после `next build`. Имена в 7z всегда UTF-16,
 * поэтому кириллица не искажается (в отличие от cp437-имён в ZIP).
 */

interface SevenZipFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string, opts?: { encoding?: 'binary' }): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  mkdir(path: string): unknown;
  isDir(mode: number): boolean;
}

interface SevenZipModule {
  FS: SevenZipFS;
  callMain(args: string[]): void;
}

// Модуль WASM грузится один раз на процесс (как каталоги/морфология в lib/ml).
const g = globalThis as unknown as { __hrSevenZip?: Promise<SevenZipModule> };

function sevenZip(): Promise<SevenZipModule> {
  if (!g.__hrSevenZip) {
    g.__hrSevenZip = (async () => {
      const factory = (await import('7z-wasm')).default;
      // stdout/stderr 7-Zip'а в логи не нужны — вывод листинга большого архива
      // только замусорит консоль сервера.
      return factory({ print: () => undefined, printErr: () => undefined });
    })().catch((e) => {
      g.__hrSevenZip = undefined; // сбой загрузки WASM не кэшируем
      throw e;
    });
  }
  return g.__hrSevenZip;
}

/** Рекурсивный обход распакованного каталога в памяти WASM. */
function walk(fs: SevenZipFS, dir: string, rel: string, out: ZipEntry[]): void {
  for (const name of fs.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    const relName = rel ? `${rel}/${name}` : name;
    if (fs.isDir(fs.stat(full).mode)) {
      out.push({ name: `${relName}/`, dir: true, read: () => Buffer.alloc(0) });
      walk(fs, full, relName, out);
    } else {
      out.push({
        name: relName,
        dir: false,
        read: () => Buffer.from(fs.readFile(full, { encoding: 'binary' })),
      });
    }
  }
}

/** Записи 7z-архива в том же виде, что readZipEntries для ZIP. */
export async function readSevenZipEntries(data: Buffer): Promise<ZipEntry[]> {
  const mod = await sevenZip();
  const stamp = `a${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const archive = `/${stamp}.7z`;
  const outDir = `/${stamp}_out`;

  mod.FS.writeFile(archive, data);
  mod.FS.mkdir(outDir);
  // x — распаковка с путями; -y — отвечать «да» (перезапись без вопросов).
  mod.callMain(['x', archive, `-o${outDir}`, '-y']);

  const entries: ZipEntry[] = [];
  walk(mod.FS, outDir, '', entries);
  if (!entries.some((e) => !e.dir)) {
    throw new Error('архив пуст или не распакован (повреждён либо зашифрован)');
  }
  return entries;
}
