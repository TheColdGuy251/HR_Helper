import 'server-only';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';
import { convertToModern } from '@/lib/parsers/office-convert';
import { withTempFile } from './common';

/**
 * Извлечение встроенной картинки (фото сотрудника) из книги Excel.
 *
 * Выгрузка "Справка на сотрудника" из 1С:ЗиК несёт фото прямо в книге.
 * SheetJS картинки не читает, поэтому:
 *  - .xlsx/.xlsm - это zip: медиа лежат в xl/media/*;
 *  - .xls (BIFF) - картинка фрагментирована по записям, честно её собрать
 *    сложно; конвертируем книгу в .xlsx через LibreOffice (он уже используется
 *    парсерами) и читаем медиа из результата.
 *
 * Фото - необязательное украшение: любая ошибка здесь даёт null и не мешает
 * формированию документа.
 */

export interface WorkbookPhoto {
  data: Buffer;
  ext: 'png' | 'jpeg';
  /** Размер в пикселях - для вписывания в рамку с сохранением пропорций. */
  width: number;
  height: number;
}

/** Размеры PNG из IHDR (байты 16..24 после сигнатуры). */
function pngDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Размеры JPEG из первого SOF-маркера (C0..CF, кроме C4/C8/CC). */
function jpegDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

/** Первая пригодная картинка из xl/media (при нескольких - самая большая). */
function photoFromXlsxZip(data: Buffer): WorkbookPhoto | null {
  let zip: PizZip;
  try {
    zip = new PizZip(data);
  } catch {
    return null;
  }
  const candidates: WorkbookPhoto[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/media\//.test(name)) continue;
    const ext = name.split('.').pop()?.toLowerCase();
    const buf = zip.files[name].asNodeBuffer() as Buffer;
    if (ext === 'png') {
      const dims = pngDims(buf);
      if (dims) candidates.push({ data: buf, ext: 'png', ...dims });
    } else if (ext === 'jpg' || ext === 'jpeg') {
      const dims = jpegDims(buf);
      if (dims) candidates.push({ data: buf, ext: 'jpeg', ...dims });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.data.length - a.data.length);
  return candidates[0];
}

/**
 * Фото из книги Excel по расширению исходного файла. null - фото нет либо
 * извлечь не удалось (например, не установлен LibreOffice для .xls).
 */
export async function extractWorkbookPhoto(
  data: Buffer,
  suffix: string
): Promise<WorkbookPhoto | null> {
  const ext = suffix.toLowerCase();
  try {
    if (ext === '.xlsx' || ext === '.xlsm') return photoFromXlsxZip(data);
    if (ext === '.xls') {
      return await withTempFile('.xls', data, async (file) => {
        const converted = await convertToModern(file);
        try {
          return photoFromXlsxZip(await readFile(converted));
        } finally {
          await rm(path.dirname(converted), { recursive: true, force: true }).catch(() => undefined);
        }
      });
    }
  } catch {
    /* фото - опциональная часть справки, документ формируется и без него */
  }
  return null;
}
