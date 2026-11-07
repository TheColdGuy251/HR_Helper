import 'server-only';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { DOCS_DIR } from '@/lib/news';
import { detectPiiDocument } from '@/lib/pii';
import { analyzeBlank, autofillDocx, renderFieldPreviewDocx, type FieldSpec } from './autofill';
import { GENERATED_DIR, timestamp } from './common';

/**
 * Рендер документов по шаблонам.
 *
 * Шаблоны бывают двух видов:
 *  1) с {{ переменными }} - рендерим через docxtemplater (делимитеры переставлены
 *     на {{ }}, как в существующих шаблонах);
 *  2) бланк без переменных - значения подставляются прямо в "пустографки" с
 *     сохранением формата места (см. lib/docs/autofill.ts).
 *
 * Рендер вынесен из app/api/documents/generate/route.ts: им же пользуется
 * генерация документов внутри диалога (lib/docs/docgen.ts).
 */

export const TEMPLATES_DIR = path.join(DOCS_DIR, 'templates');

/** Запрещённые в имени файла символы -> "_". */
export function safeFilename(s: string): string {
  const bad = '<>:"/\\|?*';
  const out = Array.from(s)
    .map((ch) => (bad.includes(ch) ? '_' : ch))
    .join('')
    .trim();
  return out.slice(0, 120) || 'document';
}

/** Относительный путь считается от docs/templates. */
export function templatePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(TEMPLATES_DIR, filePath);
}

// Делимитеры: у docxtemplater по умолчанию "{ }", а в шаблонах "{{ }}".
const DELIMITERS = { start: '{{', end: '}}' };

/** Тег "{{ surname }}" приходит с пробелами; поддерживаем и точечный путь. */
function tagParser(tag: string) {
  const name = tag.trim();
  return {
    get(scope: unknown): unknown {
      if (name === '.') return scope;
      let cur: unknown = scope;
      for (const part of name.split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[part];
      }
      return cur;
    },
  };
}

function buildDoc(content: Buffer) {
  return new Docxtemplater(new PizZip(content), {
    delimiters: DELIMITERS,
    paragraphLoop: true,
    linebreaks: true,
    parser: tagParser,
    // null -> пустая строка: в бланке нужно пустое место для незаполненных
    // (в т.ч. опциональных) полей, а не буквальное "null".
    nullGetter: () => '',
  });
}

// Части docx, где ищем переменные: тело, колонтитулы.
const TEMPLATE_PARTS = /^word\/(document\d*|header\d*|footer\d*)\.xml$/;

/**
 * Есть ли в .docx хоть один тег {{ ... }}.
 * Разметку снимаем перед поиском: Word режет "{{ date_start }}" на несколько
 * <w:t>, и по сырому XML тег не найдётся. (Штатный InspectModule
 * docxtemplater не годится - он тянет lodash, которого в проекте нет.)
 */
export function hasJinjaPlaceholders(content: Buffer): boolean {
  try {
    const zip = new PizZip(content);
    for (const name of Object.keys(zip.files)) {
      if (!TEMPLATE_PARTS.test(name)) continue;
      const text = zip.files[name].asText().replace(/<[^>]*>/g, '');
      if (/\{\{[\s\S]*?\}\}/.test(text)) return true;
    }
    return false;
  } catch {
    return false; // битый шаблон
  }
}

/** Значения в контекст: null - пустая строка, остальное - строкой. */
function toJinjaValue(v: unknown): unknown {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return v;
}

/** Готовый .docx по шаблону и значениям полей (render_template без записи). */
export function renderTemplateBuffer(content: Buffer, fields: Record<string, unknown>): Buffer {
  if (hasJinjaPlaceholders(content)) {
    const doc = buildDoc(content);
    const context: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) context[k] = toJinjaValue(v);
    doc.render(context);
    return doc.toBuffer();
  }
  // Бланк без переменных: значения идут в области ввода как есть (без подмены
  // null на "" - autofill сам пропускает незаполненные поля).
  return autofillDocx(content, fields);
}

/**
 * render_template: рендерит шаблон и кладёт результат в docs/generated.
 * Возвращает абсолютный путь к файлу.
 */
export async function renderTemplate(
  tpl: { key: string; file_path: string },
  fields: Record<string, unknown>
): Promise<string> {
  const src = templatePath(tpl.file_path);
  let content: Buffer;
  try {
    content = await readFile(src);
  } catch {
    throw new Error(`Шаблон не найден: ${src}`);
  }
  const outPath = path.join(GENERATED_DIR, `${safeFilename(tpl.key)}_${timestamp()}.docx`);
  const result = renderTemplateBuffer(content, fields);
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(outPath, result);
  return outPath;
}

/**
 * generate_document: рендер + запись в "Мои документы".
 * Бросает ошибку, если шаблона нет или рендер упал.
 */
export async function generateDocument(
  userId: string,
  templateKey: string,
  fields: Record<string, unknown>,
  title: string | null = null
) {
  const tpl = await prisma.doc_templates.findUnique({ where: { key: templateKey } });
  if (!tpl) throw new Error(`Шаблон '${templateKey}' не найден`);

  const outPath = await renderTemplate(tpl, fields);

  return prisma.my_documents.create({
    data: {
      user_id: userId,
      title: title || tpl.title,
      generator: 'template',
      template_id: tpl.id,
      file_path: outPath,
      progress: 100,
      status: 'ready',
      fields: fields as unknown as Prisma.InputJsonValue,
      // ПДн-документы не храним: пометка включает скрытие из "Моих документов"
      // и автоудаление по TTL (pii_cleanup).
      is_pii: detectPiiDocument(templateKey, Object.values(fields)),
    },
  });
}

/**
 * auto_field_schema: авто-определённая схема полей бланка без переменных - для
 * регистрации шаблона и уточняющих вопросов. {name,label,type,required}.
 */
export async function autoFieldSchema(filePath: string): Promise<FieldSpec[]> {
  return analyzeBlank(await readFile(filePath));
}

/**
 * Путь к версии шаблона для просмотра/скачивания. Для
 * бланка .docx без {{переменных}} - версия с подставленными названиями авто-полей
 * (кэшируется в docs/templates/.previews, пересобирается при правке исходника).
 * Для остального (docx с переменными, pdf) - оригинал. Если рендер превью упал - тоже
 * оригинал.
 *
 * Публичное имя - templateDisplayPath в lib/kb.ts: там же живут вызывающие
 * роуты, а путь шаблона они уже разрешили сами (поэтому принимаем src, а не
 * запись шаблона, как питоновский оригинал).
 */
export async function templatePreviewPath(tplId: string, src: string): Promise<string> {
  if (path.extname(src).toLowerCase() !== '.docx') return src;

  const source = await Promise.all([readFile(src), stat(src)]).catch(() => null);
  if (!source) return src; // отсутствие исходника разбирает вызывающий код
  const [content, srcStat] = source;
  if (hasJinjaPlaceholders(content)) return src;

  const cacheDir = path.join(TEMPLATES_DIR, '.previews');
  const out = path.join(cacheDir, `${tplId}.docx`);
  try {
    const outStat = await stat(out).catch(() => null);
    if (!outStat || outStat.mtimeMs < srcStat.mtimeMs) {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(out, renderFieldPreviewDocx(content));
    }
  } catch {
    // preview рендер шаблона не удался - отдаём оригинал
    return src;
  }
  return out;
}
