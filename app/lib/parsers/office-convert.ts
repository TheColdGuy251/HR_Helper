import 'server-only';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { baseName, stemOf, suffixOf } from '../news';
import { BinaryTimeoutError, firstExisting, runBinary, which } from './external';

/**
 * Конвертация старых форматов Office (.doc/.xls/.ppt/.rtf/.odt/.ods) в новые
 * через LibreOffice headless (`soffice --convert-to`). Порт
 * backend/services/parsers/office_convert.py.
 *
 * Если LibreOffice не установлен — бросаем понятную ошибку (документ попадёт в
 * статус failed с подсказкой), сервис не падает.
 */

// Старый формат → целевой современный.
const TARGET_EXT: Record<string, string> = {
  '.doc': 'docx',
  '.rtf': 'docx',
  '.odt': 'docx',
  '.xls': 'xlsx',
  '.ods': 'xlsx',
  '.ppt': 'pptx',
  '.odp': 'pptx',
};

/** Тайм-аут конвертации — как в Python (subprocess.run(timeout=180)). */
const CONVERT_TIMEOUT_MS = 180_000;

let soffceCache: string | null = null;

/**
 * Путь к soffice: сначала переменная окружения SOFFICE_CMD, затем PATH, затем
 * стандартные места установки. Результат кэшируется на процесс, как в Python.
 */
export function findSoffice(): string | null {
  if (soffceCache) return soffceCache;
  const found = firstExisting([
    process.env.SOFFICE_CMD,
    which('soffice'),
    which('libreoffice'),
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/opt/libreoffice/program/soffice',
  ]);
  if (found) soffceCache = found;
  return found;
}

/**
 * Общая часть обеих конвертаций: временный каталог, отдельный профиль,
 * запуск soffice и поиск получившегося файла. `outdir` остаётся за вызывающим —
 * он обязан удалить его после разбора результата.
 */
async function convert(
  file: string,
  target: string,
  opts: { prefix: string; soffice: string; timeoutMessage: string; missingMessage: string }
): Promise<string> {
  const outdir = await mkdtemp(path.join(os.tmpdir(), opts.prefix));
  // Отдельный профиль на каждый вызов — снимает блокировку «soffice уже запущен»
  // при параллельных конвертациях.
  const profile = pathToFileURL(path.join(outdir, 'profile')).href;
  const args = [
    `-env:UserInstallation=${profile}`,
    '--headless',
    '--norestore',
    '--convert-to',
    target,
    '--outdir',
    outdir,
    file,
  ];

  let stderr: Buffer;
  try {
    ({ stderr } = await runBinary(opts.soffice, args, { timeoutMs: CONVERT_TIMEOUT_MS }));
  } catch (e) {
    await rm(outdir, { recursive: true, force: true });
    if (e instanceof BinaryTimeoutError) throw new Error(opts.timeoutMessage);
    throw new Error(`Ошибка запуска LibreOffice: ${e instanceof Error ? e.message : e}`);
  }

  const stem = stemOf(baseName(file));
  let out: string | null = path.join(outdir, `${stem}.${target}`);
  const names = await readdir(outdir).catch(() => [] as string[]);
  if (!names.includes(`${stem}.${target}`)) {
    // soffice иногда именует иначе — берём первый файл нужного типа
    const alt = names.find((n) => suffixOf(n).toLowerCase() === `.${target}`);
    out = alt ? path.join(outdir, alt) : null;
  }
  if (!out) {
    const err = stderr.toString('utf8').slice(0, 300);
    await rm(outdir, { recursive: true, force: true });
    throw new Error(`${opts.missingMessage} ${err}`.trim());
  }
  return out;
}

/**
 * Конвертирует старый формат в современный. Возвращает путь к новому файлу
 * (во временной директории — вызывающий должен удалить её после парсинга).
 * Бросает Error при отсутствии LibreOffice или ошибке конвертации.
 */
export async function convertToModern(file: string): Promise<string> {
  const suffix = suffixOf(baseName(file)).toLowerCase();
  const target = TARGET_EXT[suffix];
  if (!target) throw new Error(`Формат ${suffix} не поддерживается конвертером`);

  const soffice = findSoffice();
  if (!soffice) {
    throw new Error(
      'Не найден LibreOffice (soffice) для конвертации старого формата ' +
        `${suffix}. Установите LibreOffice или укажите SOFFICE_CMD в .env.`
    );
  }
  return convert(file, target, {
    prefix: 'lo_conv_',
    soffice,
    timeoutMessage: 'Конвертация LibreOffice превысила тайм-аут (180 с)',
    missingMessage: 'LibreOffice не создал выходной файл.',
  });
}

/**
 * Конвертирует документ (pptx/ppt/odp/docx/…) в PDF через LibreOffice для
 * предпросмотра в браузере. Возвращает путь к PDF во временной директории —
 * вызывающий обязан удалить её (dirname) после использования.
 */
export async function convertToPdf(file: string): Promise<string> {
  const soffice = findSoffice();
  if (!soffice) {
    throw new Error(
      'Не найден LibreOffice (soffice) для конвертации в PDF. ' +
        'Установите LibreOffice или укажите SOFFICE_CMD в .env.'
    );
  }
  return convert(file, 'pdf', {
    prefix: 'lo_pdf_',
    soffice,
    timeoutMessage: 'Конвертация LibreOffice в PDF превысила тайм-аут (180 с)',
    missingMessage: 'LibreOffice не создал PDF.',
  });
}
