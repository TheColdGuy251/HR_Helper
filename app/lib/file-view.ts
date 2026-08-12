import 'server-only';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { prisma } from './db';
import {
  asDict,
  baseName,
  fromDocsPath,
  internalError,
  isFile,
  pyBool,
  resolveInsideDocs,
  suffixOf,
  templateDisplayPath,
  TEMPLATES_DIR,
} from './kb';
import { fromUploadPath } from './messenger';
import { mdToHtml } from './markdown';
import { sequenceOpcodes } from './docs/seqmatch';
import { parseFile } from './parsers';

/**
 * Контекст просмотрщика документов — порт _build_view_ctx, _build_diff_html и
 * тел пяти view-роутов из backend/routes/pages.py.
 *
 * Здесь только сборка контекста; авторизацию, разбор параметров и выдачу JSON
 * делают route-handler'ы в app/api/view/*. Так же устроен Python: страницы
 * зовут общие _build_view_ctx/_view_response.
 *
 * ВАЖНО про формат ответа: набор ключей у каждого режима — часть контракта с
 * components/document-viewer.tsx, поэтому объекты собираются ровно теми полями,
 * что кладёт Python (например у mode=missing из роута нет ни content, ни
 * content_html — их там действительно нет).
 */

export type ViewMode =
  | 'pdf'
  | 'markdown'
  | 'text'
  | 'docx'
  | 'xlsx'
  | 'ocr_split'
  | 'diff'
  | 'missing'
  | 'forbidden'
  | 'unsupported';

export interface ViewCtx {
  title: string;
  download_url: string;
  mode: ViewMode;
  content?: string;
  content_html?: string;
  inline_url?: string;
  text_note?: string;
  original_url?: string;
  text_url?: string;
  source_url?: string;
  kb_doc_id?: number;
  can_edit?: boolean;
  original_pdf?: boolean;
  original_image?: boolean;
}

/**
 * Результат сборки: контекст, редирект (веб-источник без сохранённого текста)
 * или «упало 500» (в Python — необработанное исключение при поиске шаблона).
 */
export type ViewResult = { ctx: ViewCtx } | { redirect: string } | { serverError: true };

// ── _build_view_ctx ────────────────────────────────────────────────────────

const TEXT_EXTS = new Set(['.txt', '.rst', '.csv', '.log']);
const SHEET_EXTS = new Set(['.xlsx', '.xlsm', '.xls']);
const SLIDE_EXTS = new Set(['.pptx', '.ppt', '.odp']);
const LEGACY_OFFICE_EXTS = new Set(['.doc', '.rtf', '.odt', '.ods']);

/**
 * read_text(encoding="utf-8", errors="ignore"): Node на битых байтах ставит
 * U+FFFD, а Python их выбрасывает — убираем, чтобы текст совпадал (тот же
 * приём, что в lib/parsers/index.ts::parseTextFile).
 */
async function readTextIgnore(file: string): Promise<string> {
  return (await readFile(file, 'utf8')).replace(/\uFFFD/g, '');
}

/**
 * Готовит контекст шаблона просмотра по пути к локальному файлу.
 * Режим: pdf (нативно), markdown, text (извлечённый), missing/forbidden/unsupported.
 */
export async function buildViewCtx(
  sourceUri: string | null | undefined,
  title: string | null | undefined,
  downloadUrl: string
): Promise<ViewCtx> {
  const ctx: ViewCtx = {
    title: title || 'Документ',
    download_url: downloadUrl,
    mode: 'unsupported',
    content: '',
    content_html: '',
  };

  // Проверка пути (как при скачивании) — только внутри docs_dir.
  // resolveInsideDocs повторяет Path(...).resolve().relative_to(docs_dir):
  // пустой/чужой путь и None дают forbidden.
  const file = resolveInsideDocs(sourceUri || '');
  if (!file) {
    ctx.mode = 'forbidden';
    return ctx;
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    ctx.mode = 'missing';
    return ctx;
  }

  const inlineUrl = `${downloadUrl}?inline=1`;
  const ext = suffixOf(baseName(file)).toLowerCase();
  try {
    if (ext === '.pdf') {
      // Полностью нативный просмотр — без обёртки приложения (клиент уйдёт на inline_url)
      ctx.mode = 'pdf';
      ctx.inline_url = inlineUrl;
    } else if (ext === '.md') {
      ctx.mode = 'markdown';
      ctx.content_html = mdToHtml(await readTextIgnore(file));
    } else if (TEXT_EXTS.has(ext)) {
      ctx.mode = 'text';
      ctx.content = await readTextIgnore(file);
    } else if (ext === '.docx') {
      // Полное оформление через docx-preview (клиентский рендер из inline-байтов)
      ctx.mode = 'docx';
      ctx.inline_url = inlineUrl;
    } else if (SHEET_EXTS.has(ext)) {
      // Листы/таблицы через SheetJS
      ctx.mode = 'xlsx';
      ctx.inline_url = inlineUrl;
    } else if (SLIDE_EXTS.has(ext)) {
      // Презентации: у браузера нет нативного просмотрщика — конвертируем в
      // PDF (LibreOffice, с кэшем) и показываем его нативно.
      ctx.mode = 'pdf';
      ctx.inline_url = `${inlineUrl}&as=pdf`;
    } else if (LEGACY_OFFICE_EXTS.has(ext)) {
      // Старые форматы Office: конвертируем (LibreOffice) и показываем текст
      ctx.mode = 'text';
      ctx.content = (await parseFile(file)).text;
    } else {
      ctx.mode = 'unsupported';
    }
  } catch (e) {
    console.warn(
      `document_view parse failed for ${sourceUri}: ${e instanceof Error ? e.message : e}`
    );
    ctx.mode = 'unsupported';
  }
  return ctx;
}

// ── _build_diff_html ───────────────────────────────────────────────────────

/** str.splitlines(): режет по всем юникодным переводам строк, хвостовой пустой отбрасывает. */
function splitLines(s: string): string[] {
  if (!s) return [];
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029]/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function escapeLine(s: string): string {
  // Пустая строка схлопнулась бы в ноль высоты — ставим неразрывный пробел.
  if (!s.trim()) return '&nbsp;';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Построчный diff старого и нового текста страницы: новый/изменённый текст —
 * красным (dvd-add), удалённый — зачёркнутым (dvd-del), без изменений — как есть.
 */
export function buildDiffHtml(oldText: string, newText: string): string {
  const oldLines = splitLines(oldText || '');
  const newLines = splitLines(newText || '');
  const out: string[] = [];
  for (const [tag, i1, i2, j1, j2] of sequenceOpcodes(oldLines, newLines)) {
    if (tag === 'equal') {
      for (const x of newLines.slice(j1, j2)) out.push(`<div class='dvd-line'>${escapeLine(x)}</div>`);
      continue;
    }
    if (tag === 'delete' || tag === 'replace') {
      for (const x of oldLines.slice(i1, i2)) {
        out.push(`<div class='dvd-line dvd-del'>${escapeLine(x)}</div>`);
      }
    }
    if (tag === 'insert' || tag === 'replace') {
      for (const x of newLines.slice(j1, j2)) {
        out.push(`<div class='dvd-line dvd-add'>${escapeLine(x)}</div>`);
      }
    }
  }
  return out.join('');
}

// ── документ базы знаний ───────────────────────────────────────────────────

const OCR_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const BIG_DOCX_BYTES = 6 * 1024 * 1024;

interface KbDocRow {
  id: number;
  title: string | null;
  source_type: string;
  source_uri: string;
  content: string | null;
  status: string;
  extra: unknown;
}

export interface ViewerUser {
  is_admin: boolean;
  is_kb_editor: boolean;
}

/** Query-параметры /kb/documents/{id}/view (в Python — int | None). */
export interface KbViewQuery {
  text: number | null;
  diff: number | null;
  original: number | null;
}

async function kbDocumentViewCtx(
  doc: KbDocRow,
  user: ViewerUser,
  q: KbViewQuery
): Promise<ViewResult> {
  const downloadUrl = `/api/kb/documents/${doc.id}/download`;
  const content = doc.content || '';

  // А6: редактор БЗ может править извлечённый текст прямо со страницы просмотра
  const canEdit = Boolean(
    (user.is_admin || user.is_kb_editor) && content.trim() && doc.status === 'indexed'
  );

  // ?text=1 — текстовая версия любого документа (извлечённый текст всегда
  // отображается, в отличие от тяжёлых/сложных оригиналов).
  if (q.text && content.trim()) {
    return {
      ctx: {
        title: doc.title || 'Документ',
        download_url: downloadUrl,
        mode: 'text',
        content: doc.content ?? '',
        text_note: 'Показан извлечённый текст документа (по нему ищет и отвечает бот).',
        original_url: `/kb/documents/${doc.id}/view?original=1`,
        kb_doc_id: doc.id,
        can_edit: canEdit,
      },
    };
  }

  if (q.diff) {
    const n = await prisma.notifications.findUnique({ where: { id: q.diff } });
    const oldContent = n ? asDict(n.extra).old_content : undefined;
    if (n && n.document_id === doc.id && oldContent !== undefined && oldContent !== null) {
      return {
        ctx: {
          title: `Обновление: ${doc.title || 'Документ'}`,
          download_url: downloadUrl,
          mode: 'diff',
          // `old_content or ""` в Python: не-строку сюда никто не кладёт.
          content_html: buildDiffHtml(pyBool(oldContent) ? String(oldContent) : '', content),
          content: '',
          source_url: doc.source_uri,
        },
      };
    }
    // Уведомление чужое/без старой версии — показываем документ как обычно.
  }

  // Веб-источник: показываем, ЧТО РАСПАРСИЛОСЬ (сохранённый текст), с оформлением.
  // Файла на диске нет; если текст ещё не сохранён (старые записи) — открываем оригинал.
  if (doc.source_type === 'web') {
    if (doc.content) {
      return {
        ctx: {
          title: doc.title || 'Документ',
          download_url: downloadUrl, // для web → редирект на оригинал
          mode: 'markdown',
          content_html: mdToHtml(doc.content),
          content: '',
          source_url: doc.source_uri,
          kb_doc_id: doc.id,
          can_edit: canEdit,
        },
      };
    }
    if (doc.source_uri) return { redirect: doc.source_uri };
  }

  // Если к документу применялся OCR — показываем ДВА предпросмотра рядом:
  // слева оригинал (PDF/скан), справа извлечённый (распознанный) текст.
  if (pyBool(asDict(doc.extra).ocr_applied) && content.trim()) {
    const ext = doc.source_uri ? suffixOf(baseName(doc.source_uri)).toLowerCase() : '';
    return {
      ctx: {
        title: doc.title || 'Документ',
        download_url: downloadUrl,
        mode: 'ocr_split',
        inline_url: `${downloadUrl}?inline=1`,
        content: doc.content ?? '',
        original_pdf: ext === '.pdf',
        original_image: OCR_IMAGE_EXTS.has(ext),
        kb_doc_id: doc.id,
        can_edit: canEdit,
      },
    };
  }

  const ctx = await buildViewCtx(doc.source_uri, doc.title || 'Документ', downloadUrl);
  ctx.kb_doc_id = doc.id;
  ctx.can_edit = canEdit;

  if (ctx.mode === 'docx' && content.trim()) {
    ctx.text_url = `/kb/documents/${doc.id}/view?text=1`;
    // Тяжёлые docx (гигантские EMF-схемы и т.п.) вешают клиентский рендер,
    // а EMF браузер не отображает вовсе (пустые страницы) — по умолчанию
    // показываем извлечённый текст; оригинал — по явному запросу (?original=1).
    const info = doc.source_uri ? await stat(fromDocsPath(doc.source_uri)).catch(() => null) : null;
    const big = Boolean(info && info.size > BIG_DOCX_BYTES);
    if (big && !q.original) {
      ctx.mode = 'text';
      ctx.content = doc.content ?? '';
      ctx.text_note =
        'Файл большой или содержит элементы, которые браузер не отображает ' +
        '(например, EMF-схемы) — показан извлечённый текст.';
      ctx.original_url = `/kb/documents/${doc.id}/view?original=1`;
    }
  }
  return { ctx };
}

// ── пять точек входа (по одной на view-роут Python) ────────────────────────
// Записи достаются здесь, а не в route-handler'ах: весь перенесённый код
// собран в одном месте и вызывается из всех пяти роутов единообразно.

/** Контекст «отсутствующей» записи: у Python в этой ветке всего три ключа. */
function missingCtx(title: string, downloadUrl: string): ViewCtx {
  return { title, download_url: downloadUrl, mode: 'missing' };
}

/**
 * Просмотр документа базы знаний. Порт document_view: режимы ?text=1,
 * ?diff=<notification_id>, ?original=1, веб-источники, OCR-раскладка и
 * авто-деградация тяжёлых docx в текст.
 */
export async function kbDocumentView(
  id: number | null,
  user: ViewerUser,
  q: KbViewQuery
): Promise<ViewResult> {
  const downloadUrl = `/api/kb/documents/${id}/download`;
  const doc = id === null ? null : await prisma.kb_documents.findUnique({ where: { id } });
  if (!doc) return { ctx: missingCtx('Документ', downloadUrl) };
  return kbDocumentViewCtx(doc, user, q);
}

/** Просмотр шаблона документа (.docx — docx-preview, .pdf — нативно). */
export async function kbTemplateView(id: number | null): Promise<ViewResult> {
  const downloadUrl = `/api/kb/templates/${id}/download`;
  const tpl = id === null ? null : await prisma.doc_templates.findUnique({ where: { id } });
  if (!tpl) return { ctx: missingCtx('Шаблон', downloadUrl) };

  // Относительный путь Python достраивает от docs/templates, а отсутствие файла
  // роняет страницу FileNotFoundError'ом (_resolve_template_path его не ловит).
  const src = path.isAbsolute(tpl.file_path)
    ? tpl.file_path
    : path.join(TEMPLATES_DIR, tpl.file_path);
  if (!(await isFile(src))) return { serverError: true };

  // Для бланка без переменных показываем версию с подставленными названиями авто-полей.
  const display = await templateDisplayPath(tpl.id, src);
  return { ctx: await buildViewCtx(display, tpl.title || 'Шаблон', downloadUrl) };
}

/** Просмотр документа пользователя («Мои документы») — те же режимы. */
export async function myDocumentView(id: number | null): Promise<ViewResult> {
  const downloadUrl = `/api/documents/${id}/download`;
  // Документы общие для всех сотрудников — без проверки владельца (по #2).
  const doc = id === null ? null : await prisma.my_documents.findUnique({ where: { id } });
  if (!doc) return { ctx: missingCtx('Документ', downloadUrl) };
  return { ctx: await buildViewCtx(doc.file_path, doc.title || 'Документ', downloadUrl) };
}

/**
 * Файл мессенджера/новости: download_url перебивается на ?download=1, а
 * inline_url строится от базового адреса (без принудительного скачивания).
 */
async function attachmentViewCtx(
  storedPath: string,
  originalName: string,
  base: string
): Promise<ViewCtx> {
  const ctx = await buildViewCtx(storedPath, originalName, base);
  ctx.download_url = `${base}?download=1`; // кнопка «Скачать» — принудительно
  return ctx;
}

/** Просмотр файла из мессенджера (pdf/docx/xlsx/текст — как в /kb). */
export async function messengerFileView(id: number | null): Promise<ViewResult> {
  const base = `/api/messenger/files/${id}`;
  const rec = id === null ? null : await prisma.user_message_files.findUnique({ where: { id } });
  if (!rec) return { ctx: missingCtx('Файл', base) };
  // Вложения мессенджера хранятся относительно СВОЕГО каталога (UPLOAD_DIR),
  // поэтому до общего buildViewCtx путь доводим до абсолютного здесь.
  return { ctx: await attachmentViewCtx(fromUploadPath(rec.stored_path), rec.original_name, base) };
}

/** Просмотр файла, прикреплённого к новости. */
export async function newsMediaView(id: number | null): Promise<ViewResult> {
  const base = `/api/news/media/${id}`;
  const m = id === null ? null : await prisma.news_media.findUnique({ where: { id } });
  if (!m) return { ctx: missingCtx('Файл', base) };
  return { ctx: await attachmentViewCtx(m.stored_path, m.original_name, base) };
}

// ── ответ ──────────────────────────────────────────────────────────────────

/**
 * Порт _view_response для SPA-ветки (?format=json): контекст отдаётся как JSON.
 * Редирект на веб-источник Python делает и при format=json — повторяем;
 * NextResponse.redirect не годится, он валидирует URL, а RedirectResponse нет.
 */
export function viewResponse(result: ViewResult): NextResponse {
  if ('serverError' in result) return internalError();
  if ('redirect' in result) {
    return new NextResponse(null, { status: 302, headers: { Location: result.redirect } });
  }
  return NextResponse.json(result.ctx);
}
