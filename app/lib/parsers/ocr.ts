import 'server-only';
import sharp, { type Sharp } from 'sharp';
import { BinaryNotFoundError, firstExisting, runBinary, which } from './external';

/**
 * OCR — порт backend/services/parsers/ocr.py. Распознаёт Tesseract'ом
 * (внешний бинарь, как pytesseract в Python), препроцессинг вместо OpenCV
 * делает sharp.
 *
 * ОТЛИЧИЯ ОТ PYTHON:
 *  - денойз: у cv2 это fastNlMeansDenoising (нелокальные средние), у sharp
 *    такого фильтра нет — берём медиану 3×3 при том же ограничении по площади;
 *  - deskew: угол считаем сами (Оцу + выпуклая оболочка + минимальный
 *    объемлющий прямоугольник — то же, что cv2.minAreaRect), но оценку делаем
 *    по уменьшенной копии (быстрее) и поворачиваем через sharp: холст при этом
 *    расширяется и заполняется белым, а не BORDER_REPLICATE;
 *  - изображение отдаётся Tesseract'у через stdin, без временного файла
 *    (pytesseract пишет временный PNG).
 */

// Защита от OOM/зависаний на больших фото: ограничиваем сторону изображения
// и не запускаем дорогой денойз на крупных картинках (он ~квадратичен по площади).
const OCR_MAX_DIM = 2600;
const OCR_DENOISE_MAX_PIXELS = 1_500_000;
// Мелкие сканы распознаются плохо — апскейлим до этой минимальной длинной стороны.
const OCR_MIN_DIM = 1000;
// Если качество распознавания ниже — пробуем дополнительные проходы/варианты.
const OCR_GOOD_QUALITY = 0.55;
// Ниже этого порога считаем распознанное ненадёжным (флаг low_quality).
const OCR_MIN_QUALITY = 0.3;

/** Один проход Tesseract'а не может идти вечно: у Python тайм-аута нет, у нас есть. */
const OCR_TIMEOUT_MS = 120_000;

/** Оценку наклона считаем по уменьшенной копии — точности угла хватает, а время линейно. */
const DESKEW_ESTIMATE_DIM = 1000;

/** settings.ocr_languages */
function ocrLanguages(): string {
  return process.env.OCR_LANGUAGES || 'rus+eng';
}

// Python: `[^\W\d_]{3,}` с re.UNICODE — «слово» из ≥3 букв ЛЮБОГО алфавита.
// В JS `\w` знает только ASCII, поэтому берём свойство Unicode напрямую.
const WORD_RE = /\p{L}{3,}/gu;

let tesseractCache: string | null = null;

/**
 * Путь к tesseract: переменная окружения TESSERACT_CMD, затем PATH, затем
 * стандартные места установки (порт _init_tesseract + settings.tesseract_cmd).
 */
export function findTesseract(): string | null {
  if (tesseractCache) return tesseractCache;
  const found = firstExisting([
    process.env.TESSERACT_CMD,
    which('tesseract'),
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
    '/usr/bin/tesseract',
    '/usr/local/bin/tesseract',
  ]);
  if (found) tesseractCache = found;
  return found;
}

function requireTesseract(): string {
  const cmd = findTesseract();
  if (!cmd) {
    throw new BinaryNotFoundError(
      'Не найден Tesseract для распознавания текста. Установите Tesseract ' +
        'или укажите TESSERACT_CMD в .env.'
    );
  }
  return cmd;
}

/**
 * Эвристическая оценка качества распознанного текста [0..1]: сочетание доли
 * буквенных символов и доли символов, попавших в «слова» из ≥3 букв. Мусорный
 * OCR (одиночные символы, спецзнаки) получает низкую оценку — по ней выбираем
 * лучший из нескольких проходов и помечаем ненадёжный результат.
 */
export function ocrQuality(text: string): number {
  const t = (text || '').trim();
  if (t.length < 3) return 0;
  const chars = Array.from(t);
  const letters = chars.filter((c) => /\p{L}/u.test(c)).length;
  if (letters === 0) return 0;
  const nonSpace = chars.filter((c) => !/\s/u.test(c)).length;
  const alphaRatio = letters / Math.max(nonSpace, 1);
  let wordChars = 0;
  for (const m of t.matchAll(WORD_RE)) wordChars += m[0].length;
  const wordRatio = wordChars / letters;
  return Math.round((alphaRatio * 0.5 + wordRatio * 0.5) * 10000) / 10000;
}

// ── препроцессинг (в Python — OpenCV) ──────────────────────────────────────

interface Gray {
  data: Buffer;
  width: number;
  height: number;
}

/** Порог Оцу по гистограмме (cv2.THRESH_OTSU). */
function otsuThreshold(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 0;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

type Point = [number, number];

/** Выпуклая оболочка (монотонная цепь Эндрю), точки уже отсортированы по y, затем x. */
function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Угол минимального объемлющего прямоугольника (аналог cv2.minAreaRect[-1]):
 * вращающиеся калиперы по рёбрам оболочки. Как и OpenCV ≥4.5, нормализуем
 * результат в (0, 90] — от этого зависят пороги в _deskew.
 */
function minAreaRectAngle(points: Point[]): number {
  const hull = convexHull(points);
  if (hull.length < 3) return 90;
  let bestArea = Infinity;
  let bestAngle = 90;
  for (let i = 0; i < hull.length; i += 1) {
    const [px, py] = hull[i];
    const [qx, qy] = hull[(i + 1) % hull.length];
    const dx = qx - px;
    const dy = qy - py;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      bestAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
    }
  }
  const normalized = ((bestAngle % 90) + 90) % 90;
  return normalized === 0 ? 90 : normalized;
}

/**
 * Оценка наклона скана (частая причина корявого OCR у фото документов).
 * Угол оцениваем по «облаку» тёмных пикселей текста. Возвращает угол в
 * градусах или null, если правка не нужна.
 */
export async function estimateSkew(gray: Gray): Promise<number | null> {
  const longest = Math.max(gray.width, gray.height);
  let small: Gray = gray;
  if (longest > DESKEW_ESTIMATE_DIM) {
    const scale = DESKEW_ESTIMATE_DIM / longest;
    const w = Math.max(1, Math.round(gray.width * scale));
    const h = Math.max(1, Math.round(gray.height * scale));
    const { data, info } = await sharp(gray.data, {
      raw: { width: gray.width, height: gray.height, channels: 1 },
    })
      .resize(w, h, { fit: 'fill' })
      .toColourspace('b-w') // resize над raw-входом иначе отдаёт 3 канала
      .raw()
      .toBuffer({ resolveWithObject: true });
    small = { data, width: info.width, height: info.height };
  }

  // Порог Оцу по инвертированному изображению — ровно как в Python
  // (cv2.bitwise_not + THRESH_BINARY|THRESH_OTSU).
  const hist = new Uint32Array(256);
  for (let i = 0; i < small.data.length; i += 1) hist[255 - small.data[i]] += 1;
  const t = otsuThreshold(hist, small.data.length);

  // Оболочку определяют только крайние тёмные пиксели каждой строки — их и
  // собираем, вместо миллионов точек.
  const points: Point[] = [];
  for (let y = 0; y < small.height; y += 1) {
    const row = y * small.width;
    let first = -1;
    let last = -1;
    for (let x = 0; x < small.width; x += 1) {
      if (255 - small.data[row + x] > t) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) {
      points.push([first, y]);
      if (last !== first) points.push([last, y]);
    }
  }
  if (points.length < 3) return null;

  let angle = minAreaRectAngle(points);
  if (angle < -45) angle = 90 + angle;
  // Правим только заметный, но не чрезмерный наклон (±0.5°…20°), чтобы не
  // портить и без того ровные сканы.
  if (Math.abs(angle) < 0.5 || Math.abs(angle) > 20) return null;
  return angle;
}

/** Источник картинки: фабрика конвейера sharp и уже известные размеры. */
interface ImageSource {
  make: () => Sharp;
  width: number;
  height: number;
}

/** Порт _to_gray: масштабирование + серый + денойз + выравнивание наклона. */
export async function toGray({ make, width, height }: ImageSource): Promise<Gray> {
  // Даунскейл крупных / апскейл мелких изображений: и то и другое ухудшает OCR
  // (крупные — память/время; мелкие — «рваные» глифы).
  const longest = Math.max(width, height);
  let scale = 1;
  if (longest > OCR_MAX_DIM) scale = OCR_MAX_DIM / longest;
  else if (longest < OCR_MIN_DIM) scale = Math.min(OCR_MIN_DIM / Math.max(longest, 1), 3);

  const scaledW = Math.max(1, Math.trunc(width * scale));
  const scaledH = Math.max(1, Math.trunc(height * scale));
  let pipeline = make().greyscale();
  if (scale !== 1) {
    pipeline = pipeline.resize(scaledW, scaledH, {
      fit: 'fill',
      kernel: scale < 1 ? 'lanczos3' : 'cubic',
    });
  }
  // Денойз (порт cv2.medianBlur(3)) — В ТОМ ЖЕ конвейере, до выгрузки в raw.
  // Операции sharp над raw-входом (median/blur/resize) возвращают 3-канальный
  // буфер даже для серого — повторная упаковка как channels:1 перемешивает
  // строки, и Tesseract получает «шум» вместо текста (мелкие картинки
  // распознавались в пусто). Внутри конвейера канал остаётся один.
  if (scaledW * scaledH <= OCR_DENOISE_MAX_PIXELS) {
    pipeline = pipeline.median(3);
  }
  let { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  let gray: Gray = { data, width: info.width, height: info.height };

  try {
    const angle = await estimateSkew(gray);
    if (angle !== null) {
      // cv2.getRotationMatrix2D крутит против часовой стрелки, sharp — по часовой.
      ({ data, info } = await sharp(gray.data, {
        raw: { width: gray.width, height: gray.height, channels: 1 },
      })
        .rotate(-angle, { background: { r: 255, g: 255, b: 255 } })
        .toColourspace('b-w') // rotate над raw-входом иначе отдаёт 3 канала
        .raw()
        .toBuffer({ resolveWithObject: true }));
      gray = { data, width: info.width, height: info.height };
    }
  } catch {
    /* как `except cv2.error: return gray` — наклон не правим */
  }
  return gray;
}

/**
 * Порт _binarize: cv2.adaptiveThreshold(GAUSSIAN_C, block=31, C=10).
 * Гауссово окно 31 в OpenCV — это sigma 5.0, её и даём sharp.blur.
 */
export async function binarize(gray: Gray): Promise<Buffer> {
  // toColourspace('b-w') обязателен: blur над raw-входом иначе возвращает
  // 3-канальный буфер, и индексация blurred[i] читает лишь первую треть строк —
  // порог превращается в мусор (см. комментарий в toGray).
  const blurred = await sharp(gray.data, {
    raw: { width: gray.width, height: gray.height, channels: 1 },
  })
    .blur(5)
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  const out = Buffer.allocUnsafe(gray.data.length);
  for (let i = 0; i < gray.data.length; i += 1) {
    out[i] = gray.data[i] > blurred[i] - 10 ? 255 : 0;
  }
  return out;
}

function toPng(gray: Gray, data: Buffer): Promise<Buffer> {
  return sharp(data, { raw: { width: gray.width, height: gray.height, channels: 1 } })
    .png()
    .toBuffer();
}

// ── распознавание ──────────────────────────────────────────────────────────

/** Порт _recognize: pytesseract с config "--oem 1 --psm N". */
async function recognize(png: Buffer, lang: string, psm: number): Promise<string> {
  const cmd = requireTesseract();
  const { code, stdout, stderr } = await runBinary(
    cmd,
    ['stdin', 'stdout', '-l', lang, '--oem', '1', '--psm', String(psm)],
    { timeoutMs: OCR_TIMEOUT_MS, input: png }
  );
  if (code !== 0) {
    throw new Error(`Tesseract вернул код ${code}: ${stderr.toString('utf8').slice(0, 300)}`);
  }
  return stdout.toString('utf8');
}

/**
 * Распознаёт текст изображения. Делает несколько проверок качества:
 * выравнивание наклона, бинаризация, и адаптивно — дополнительные проходы с
 * другой сегментацией страницы (PSM) и по «чистому» серому, если первый проход
 * получился низкого качества. Возвращает лучший по эвристике результат.
 */
async function ocrSharpInput(source: ImageSource, lang?: string): Promise<string> {
  const language = lang || ocrLanguages();
  const gray = await toGray(source);
  const [grayPng, binPng] = await Promise.all([
    toPng(gray, gray.data),
    binarize(gray).then((bin) => toPng(gray, bin)),
  ]);

  // Первый (основной) проход: бинаризованное изображение, PSM 6 (единый блок).
  let bestText = await recognize(binPng, language, 6);
  let bestScore = ocrQuality(bestText);

  // Низкое качество — пробуем другую сегментацию и не-бинаризованный серый:
  // для колонок/таблиц лучше PSM 4, для чистых сканов иногда серый без порога.
  if (bestScore < OCR_GOOD_QUALITY) {
    const variants: [Buffer, number][] = [
      [binPng, 4],
      [grayPng, 6],
      [binPng, 3],
    ];
    for (const [image, psm] of variants) {
      let candidate: string;
      try {
        candidate = await recognize(image, language, psm);
      } catch {
        continue; // проход упал — пробуем следующий вариант
      }
      const score = ocrQuality(candidate);
      if (score > bestScore) {
        bestText = candidate;
        bestScore = score;
      }
      if (bestScore >= OCR_GOOD_QUALITY) break;
    }
  }

  if (bestScore < OCR_MIN_QUALITY) {
    console.warn(`OCR: низкое качество распознавания (score=${bestScore.toFixed(2)})`);
  }
  return bestText;
}

/** Распознаёт текст изображения из байтов файла (png/jpg/webp/tiff/…). */
export async function ocrImageBytes(data: Buffer, lang?: string): Promise<string> {
  const meta = await sharp(data, { failOn: 'none' })
    .metadata()
    .catch(() => null);
  if (!meta?.width || !meta.height) {
    // sharp не знает формат (например .bmp) — отдаём файл Tesseract'у как есть:
    // Leptonica читает больше форматов, просто без препроцессинга.
    return recognize(data, lang || ocrLanguages(), 6);
  }
  return ocrSharpInput(
    { make: () => sharp(data, { failOn: 'none' }), width: meta.width, height: meta.height },
    lang
  );
}

// ── OCR страниц PDF ────────────────────────────────────────────────────────

interface PdfPageLike {
  rotate: number;
}
interface PdfDocLike {
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

/**
 * Распознаёт одну страницу PDF. Вместо рендера страницы (PyMuPDF get_pixmap)
 * берём вложенную в неё картинку: у сканов страница ровно ей и является.
 * Поворот страницы (/Rotate) применяем сами — pdf.js отдаёт картинку в том
 * виде, как она лежит в файле, а распознавать надо так, как страница видна.
 */
async function ocrPdfPage(pdf: PdfDocLike, index: number, lang?: string): Promise<string> {
  const { extractImages } = await import('unpdf');
  const pageNumber = index + 1;
  const images = await extractImages(pdf as never, pageNumber);
  if (!images.length) return '';

  // Скан-страница — одна картинка на всю страницу; если их несколько, самая
  // крупная и есть скан (мелкие — логотипы/подписи).
  const image = images.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  let data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  let raw: { width: number; height: number; channels: 1 | 2 | 3 | 4 } = {
    width: image.width,
    height: image.height,
    channels: image.channels,
  };

  const page = await pdf.getPage(pageNumber);
  const rotate = (((page.rotate || 0) % 360) + 360) % 360;
  if (rotate) {
    // Разворачиваем сразу, до препроцессинга: дальше размеры считаются от
    // повёрнутой картинки, иначе масштабирование их перепутает.
    const rotated = await sharp(data, { raw }).rotate(rotate).raw().toBuffer({
      resolveWithObject: true,
    });
    data = rotated.data;
    raw = {
      width: rotated.info.width,
      height: rotated.info.height,
      channels: rotated.info.channels,
    };
  }
  return ocrSharpInput(
    { make: () => sharp(data, { raw }), width: raw.width, height: raw.height },
    lang
  );
}

/** Запускает OCR для перечисленных страниц PDF (порт ocr_pdf_pages). */
export async function ocrPdfPages(
  pdf: PdfDocLike,
  pageIndices: Iterable<number>
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  for (const index of pageIndices) {
    try {
      result.set(index, await ocrPdfPage(pdf, index));
    } catch (e) {
      console.warn(`OCR страницы ${index} не удался: ${e instanceof Error ? e.message : e}`);
      result.set(index, '');
    }
  }
  return result;
}
