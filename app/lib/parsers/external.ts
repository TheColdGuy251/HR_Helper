import 'server-only';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Запуск внешних программ (Tesseract, LibreOffice) — аналог subprocess.run в
 * Python. Вынесено отдельно, потому что и OCR, и конвертер Office делают одно и
 * то же: найти бинарь, выполнить с тайм-аутом, разобрать результат.
 */

/** subprocess.run(..., capture_output=True) — код возврата и оба потока. */
export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Аналог subprocess.TimeoutExpired: вызывающий отличает тайм-аут от прочих сбоев. */
export class BinaryTimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    super(`Программа ${cmd} не ответила за ${Math.round(timeoutMs / 1000)} с`);
    this.name = 'BinaryTimeoutError';
  }
}

/** Бинаря нет или он не запускается — сообщение должно быть понятным в UI. */
export class BinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinaryNotFoundError';
  }
}

/**
 * Запускает программу, ждёт завершения и возвращает оба потока. Без shell —
 * пробелы в путях («C:\Program Files\…») передаются как есть.
 * `input` уходит в stdin (так Tesseract читает картинку без временного файла).
 */
export function runBinary(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; input?: Buffer }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      reject(new BinaryNotFoundError(`Ошибка запуска ${cmd}: ${e}`));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL'); // на Windows kill() и так завершает процесс принудительно
      reject(new BinaryTimeoutError(cmd, opts.timeoutMs));
    }, opts.timeoutMs);

    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? new BinaryNotFoundError(`Программа не найдена: ${cmd}`)
          : new BinaryNotFoundError(`Ошибка запуска ${cmd}: ${e.message}`)
      );
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });

    if (opts.input) {
      // Программа могла закрыть stdin раньше, чем мы дописали — EPIPE тут не
      // ошибка выполнения, результат всё равно придёт в close.
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

/** shutil.which: ищет исполняемый файл в PATH (на Windows — с учётом PATHEXT). */
export function which(name: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* недоступный каталог из PATH — просто пропускаем */
      }
    }
  }
  return null;
}

/** Первый существующий путь из списка кандидатов (порт цикла в _find_soffice). */
export function firstExisting(candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (existsSync(c)) return c;
    } catch {
      /* OSError в Python — тоже пропуск */
    }
  }
  return null;
}
