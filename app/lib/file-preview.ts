import 'server-only';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { NextResponse } from 'next/server';
import { DOCS_DIR, baseName, stemOf, suffixOf } from './news';
import { fileResponse, isFile } from './kb';
import { convertToPdf } from './parsers/office-convert';

/**
 * Предпросмотр «слайдовых» форматов (pptx/ppt/odp) в браузере: конвертируем в PDF
 * через LibreOffice и кэшируем результат, чтобы не конвертировать при каждом
 * открытии. Порт backend/utils/file_preview.py.
 *
 * Кэш живёт в docs/.preview_cache, ключ — путь+размер+mtime исходника (изменился
 * файл → пересобираем PDF). Используется всеми страницами просмотра через
 * параметр ?as=pdf у эндпоинтов скачивания.
 */

// Форматы, для которых нет нативного браузерного просмотрщика — показываем как PDF.
export const SLIDE_EXTS = new Set(['.pptx', '.ppt', '.odp']);

export function canPreviewAsPdf(file: string): boolean {
  return SLIDE_EXTS.has(suffixOf(baseName(file)).toLowerCase());
}

async function cacheDir(): Promise<string> {
  const dir = path.join(DOCS_DIR, '.preview_cache');
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Путь к PDF-версии презентации (с кэшированием). null — если формат не
 * поддерживается, файла нет или LibreOffice недоступен/упал.
 */
export async function previewPdfPath(src: string): Promise<string | null> {
  if (!canPreviewAsPdf(src)) return null;
  const info = await stat(src).catch(() => null);
  if (!info?.isFile()) return null;

  // Ключ кэша повторяет Python: абсолютный путь + размер + mtime в секундах.
  const key = `${path.resolve(src)}|${info.size}|${Math.trunc(info.mtimeMs / 1000)}`;
  const cached = path.join(
    await cacheDir(),
    `${createHash('sha1').update(key, 'utf8').digest('hex')}.pdf`
  );
  if (await isFile(cached)) return cached;

  let tmpPdf: string;
  try {
    tmpPdf = await convertToPdf(src);
  } catch (e) {
    console.warn(
      `Предпросмотр ${baseName(src)} как PDF не удался: ${e instanceof Error ? e.message : e}`
    );
    return null;
  }
  try {
    await copyFile(tmpPdf, cached);
  } catch (e) {
    console.warn(`Не удалось сохранить PDF-превью в кэш: ${e instanceof Error ? e.message : e}`);
    return null;
  } finally {
    await rm(path.dirname(tmpPdf), { recursive: true, force: true });
  }
  return cached;
}

/**
 * Ответ с PDF-превью (inline) или null, если превью недоступно — тогда
 * вызывающий отдаёт исходный файл, ровно как preview_pdf_response в Python.
 */
export async function previewPdfResponse(src: string): Promise<NextResponse | null> {
  const pdf = await previewPdfPath(src);
  if (!pdf) return null;
  return fileResponse(pdf, {
    filename: `${stemOf(baseName(src))}.pdf`,
    mediaType: 'application/pdf',
    inline: true,
  });
}
