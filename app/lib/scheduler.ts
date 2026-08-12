import 'server-only';
import crypto from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { broadcast, publish } from './events';
import { asDict, pyBool } from './kb';
import { baseName, cut, fromDocsPath, resolveInsideDocs, suffixOf } from './news';
import { peerKeyOf, recipientsOf, resolveInsideUpload } from './messenger';
import { isNativelyParsable } from './parsers';
import { deleteKbDocument, indexPendingFile, reindexContent } from './ml/indexer';
import { COLLECTION, qdrant } from './ml/qdrant';
import { notifyUser, notifyUsers } from './push';

// Фоновые подсистемы, у которых нет собственных HTTP-эндпоинтов.
// Порт backend/services/tasks/scheduler.py + pii_cleanup.py + возобновление
// зависших индексаций из lifespan (backend/app.py).
//
// АРХИТЕКТУРА. В Next.js нет процесса-демона: маршруты поднимаются лениво, а
// модульный код исполняется только когда в него пришёл запрос. Поэтому джобы
// живут здесь как обычные функции, а «таймер» вынесен наружу —
// scripts/worker.mjs дёргает POST /api/cron/<job>. Это принципиально: джобы
// исполняются ВНУТРИ процесса Next, а значит им доступны та же шина событий
// (SSE-подписчики живут в памяти процесса — из отдельного процесса publish()
// был бы пустышкой), тот же пул Prisma и та же очередь индексации.

// ── Логи ───────────────────────────────────────────────────────────────────

function log(job: string, message: string): void {
  console.log(`[${new Date().toISOString()}] [SCHED:${job}] ${message}`);
}

function warn(job: string, message: string): void {
  console.warn(`[${new Date().toISOString()}] [SCHED:${job}] ${message}`);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// ── Системные уведомления ──────────────────────────────────────────────────

/**
 * Создаёт запись уведомления, шлёт SSE и Web Push.
 *
 * Кому уходит push: адресное уведомление (`userId`) — своему пользователю;
 * широковещательное (события базы знаний) — редакторам БЗ и администраторам:
 * только они могут что-то сделать с устаревшим документом, остальным это был
 * бы шум. В центре уведомлений такие записи по-прежнему видят все.
 */
async function systemNotification(opts: {
  kind: string;
  title: string;
  body: string;
  userId?: number | null;
  documentId?: number | null;
  extra?: Prisma.InputJsonValue;
  url?: string;
}): Promise<number> {
  const note = await prisma.notifications.create({
    data: {
      kind: opts.kind,
      user_id: opts.userId ?? null,
      title: opts.title,
      body: opts.body,
      document_id: opts.documentId ?? null,
      extra: opts.extra ?? Prisma.DbNull,
    },
  });

  const event = { type: 'system_notification', kind: opts.kind, id: note.id };
  if (opts.userId) publish(opts.userId, event);
  else broadcast(event);

  const payload = {
    title: opts.title,
    body: cut(opts.body, 120),
    url: opts.url ?? (opts.documentId ? `/kb/documents/${opts.documentId}/view` : '/'),
    tag: `sys-${opts.kind}-${note.id}`,
  };
  if (opts.userId) {
    notifyUser(opts.userId, payload);
  } else {
    // Та же роль, что пускает в редактор БЗ (см. requireKbEditor): редактор
    // ИЛИ администратор — иначе на стенде без выделенных редакторов push
    // не ушёл бы никому.
    const editors = await prisma.users.findMany({
      where: { is_active: true, OR: [{ is_kb_editor: true }, { is_admin: true }] },
      select: { id: true },
    });
    notifyUsers(
      editors.map((u) => u.id),
      payload
    );
  }
  return note.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// Джоб 1: обновление веб-источников (каждые 30 минут)
// ═══════════════════════════════════════════════════════════════════════════

// Большинство сайтов блокирует «ботовые» UA, но часть справочных баз (Wikimedia
// и др.) наоборот требует представиться роботом — пробуем оба, как в Python.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BOT_UA = 'HRHelperBot/1.0 (+https://www.tyuiu.ru; contact: hr-helper@tyuiu.ru)';
const BLOCK_CODES = new Set([401, 403, 406, 429]);
const WEB_TIMEOUT_MS = 30_000;

/**
 * Декодирование ответа. fetch().text() всегда читает как UTF-8, а часть
 * ведомственных сайтов до сих пор отдаёт windows-1251 — без учёта charset
 * такой документ попал бы в базу знаний «кракозябрами».
 */
function decodeHtml(buf: ArrayBuffer, contentType: string | null): string {
  const bytes = Buffer.from(buf);
  const head = bytes.subarray(0, 4096).toString('latin1');
  const charset = (
    /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1] ||
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
    'utf-8'
  ).toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8'); // неизвестная метка кодировки
  }
}

/** Порт fetch_url: браузерный UA, при блокировке — повтор с бот-UA. */
async function fetchUrl(url: string): Promise<string> {
  const agents = [BROWSER_UA, BOT_UA];
  let lastError: Error | null = null;

  for (let i = 0; i < agents.length; i += 1) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': agents[i],
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
    });
    if (res.ok) return decodeHtml(await res.arrayBuffer(), res.headers.get('content-type'));

    lastError = new Error(`HTTP ${res.status}`);
    if (!(BLOCK_CODES.has(res.status) && i + 1 < agents.length)) throw lastError;
  }
  throw lastError ?? new Error('fetchUrl: недостижимо');
}

// Разметка, которая никогда не содержит полезного текста.
const DROP_TAGS = 'script|style|noscript|nav|header|footer|aside|form|svg|template|iframe';
const DROP_RE = new RegExp(`<(${DROP_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const BLOCK_END_RE =
  /<\/(p|div|section|article|li|ul|ol|tr|td|th|h[1-6]|blockquote|pre|table|dd|dt)\s*>/gi;

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', hellip: '…', deg: '°', shy: '', middot: '·', bull: '•',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', times: '×', copy: '©', sect: '§', numero: '№',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, ent: string) => {
    if (ent[0] === '#') {
      const hex = ent[1] === 'x' || ent[1] === 'X';
      const code = Number.parseInt(hex ? ent.slice(2) : ent.slice(1), hex ? 16 : 10);
      try {
        return code > 0 ? String.fromCodePoint(code) : match;
      } catch {
        return match; // код вне диапазона Unicode
      }
    }
    return ENTITIES[ent.toLowerCase()] ?? match;
  });
}

const NAV_ROW_RE = /\|.*(?:<<|>>)|(?:<<|>>).*\|/;
const PIPE_ONLY_RE = /^[\s|]+$/;

/** Порт _clean_text: убирает навигационный мусор и лишние пустые строки. */
function cleanText(text: string): string {
  if (!text) return '';
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const s = line.replace(/[ \t ]+/g, ' ').trim();
    if (!s) {
      out.push('');
      continue;
    }
    if (PIPE_ONLY_RE.test(s) || NAV_ROW_RE.test(s)) continue;
    out.push(s);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * HTML → текст. Аналог запасного экстрактора _bs4_extract: берём <article>/
 * <main> (иначе <body>), выбрасываем служебные блоки, закрывающие блочные теги
 * превращаем в переводы строк.
 *
 * ОГРАНИЧЕНИЕ: в Python основной путь — trafilatura (отсеивает сайдбары, ленты
 * новостей, «читайте также»); в Node аналога нет, поэтому текст получается
 * «шумнее». На качество ответа влияет умеренно — чанки с меню коротки и почти
 * не набирают релевантность, — но для сложных порталов лучше оставить парсинг
 * источников за FastAPI.
 */
function htmlToText(html: string): string {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(DROP_RE, ' ');
  const region =
    /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(cleaned)?.[1] ??
    /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(cleaned)?.[1] ??
    /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(cleaned)?.[1] ??
    cleaned;

  const withBreaks = region
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_END_RE, '\n')
    .replace(/<[^>]+>/g, ' ');
  return cleanText(decodeEntities(withBreaks));
}

/** Порт _extract_title: <title> → <h1> → сам URL. */
function extractTitle(html: string, fallback: string): string {
  const raw =
    /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ??
    /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1] ??
    '';
  const title = decodeEntities(raw.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return title || fallback;
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Порт RAGIndexer.index_url: скачивает страницу, сравнивает хеш текста с уже
 * проиндексированным и при изменении полностью переиндексирует URL.
 * Возвращает true, если документ действительно переиндексирован.
 */
async function indexWebSource(job: string, url: string): Promise<boolean> {
  const html = await fetchUrl(url);
  const text = htmlToText(html);
  const title = extractTitle(html, url);
  const textHash = sha256Text(text);

  const existing = await prisma.kb_documents.findFirst({
    where: { source_uri: url, file_hash: textHash },
  });
  if (existing && existing.status === 'indexed') {
    log(job, `${url}: без изменений`);
    return false;
  }

  // Содержимое изменилось (или прошлая попытка не завершилась): старые версии
  // URL удаляем, иначе в базе знаний копятся дубли одной страницы. Прежний
  // текст запоминаем — он нужен для diff в уведомлении об обновлении.
  const stale = await prisma.kb_documents.findMany({
    where: { source_uri: url, source_type: 'web' },
    orderBy: { id: 'asc' },
  });
  let oldContent: string | null = null;
  for (const old of stale) {
    if (oldContent === null && old.status === 'indexed' && (old.content || '').trim()) {
      oldContent = old.content;
    }
    try {
      await deleteKbDocument(old.id);
    } catch (e) {
      warn(job, `не удалось удалить старую версию ${url}: ${errText(e)}`);
    }
  }

  const doc = await prisma.kb_documents.create({
    data: {
      title: cut(title, 500),
      source_type: 'web',
      source_uri: cut(url, 1000),
      file_hash: textHash,
      mime_type: 'text/html',
      status: 'pending',
      // Значений по умолчанию в схеме нет — повторяем default'ы модели KBDocument.
      priority: 2,
      is_archived: false,
      chunks_count: 0,
    },
  });

  // reindexContent — единственная переносимая точка входа «текст → индекс»:
  // она держит общий с загрузкой файлов замок индексации (эмбеддинги грузят
  // все ядра) и сама выставляет статусы/чанки/BM25.
  await reindexContent(doc.id, text);

  const fresh = await prisma.kb_documents.findUnique({ where: { id: doc.id } });
  if (!fresh || fresh.status !== 'indexed') {
    throw new Error(fresh?.error || 'индексация не завершилась');
  }

  // reindexContent помечает документ как отредактированный вручную — для
  // краулера это неверно: снимаем метку и фиксируем момент обхода.
  const extra = asDict(fresh.extra);
  delete extra.edited_at;
  extra.crawled_at = new Date().toISOString();
  await prisma.kb_documents.update({
    where: { id: doc.id },
    data: { extra: extra as Prisma.InputJsonValue },
  });

  // Настоящее ОБНОВЛЕНИЕ (была проиндексированная версия с другим текстом) —
  // системное уведомление со ссылкой на diff.
  if (oldContent !== null && oldContent.trim() !== (fresh.content || '').trim()) {
    try {
      const id = await systemNotification({
        kind: 'web_update',
        title: fresh.title || url,
        body: `Парсер обнаружил изменение веб-страницы: ${url}`,
        documentId: doc.id,
        extra: { old_content: oldContent, url },
        url: `/kb/documents/${doc.id}/view`,
      });
      log(job, `web_update: документ ${doc.id} (${url}), уведомление ${id}`);
    } catch (e) {
      warn(job, `уведомление об обновлении ${url}: ${errText(e)}`);
    }
  }

  log(job, `${url}: проиндексировано, чанков ${fresh.chunks_count}`);
  return true;
}

async function refreshWebSourcesJob(job: string): Promise<string> {
  const now = Date.now();
  const sources = await prisma.kb_sources.findMany({
    where: { is_enabled: true },
    orderBy: { id: 'asc' },
  });

  let refreshed = 0;
  let failed = 0;
  let skipped = 0;

  for (const s of sources) {
    const dueAfter = (s.refresh_interval_hours || 24) * 3600_000;
    if (s.last_crawled_at && now - s.last_crawled_at.getTime() < dueAfter) {
      skipped += 1;
      continue;
    }

    let status: string;
    try {
      const changed = await indexWebSource(job, s.url);
      if (changed) refreshed += 1;
      status = 'ok';
    } catch (e) {
      warn(job, `источник ${s.url} упал: ${errText(e)}`);
      failed += 1;
      // last_status — VARCHAR(32): длинную ошибку БД просто не примет
      // (в Python на этом падает сам джоб), поэтому режем.
      status = cut(`error: ${errText(e)}`, 32);
    }

    await prisma.kb_sources.update({
      where: { id: s.id },
      data: { last_status: status, last_crawled_at: new Date() },
    });
  }

  return `источников ${sources.length}, обновлено ${refreshed}, ошибок ${failed}, не по расписанию ${skipped}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Джоб 2: контроль актуальности документов (раз в сутки, первый — через 5 мин)
// ═══════════════════════════════════════════════════════════════════════════

// Документы «живут 3–5 лет, обновление ≥1 раз/год» (протокол): старше N лет —
// напоминание о проверке актуальности, повторно — не чаще раза в год.
const STALE_YEARS = 3;
const RENOTIFY_DAYS = 365;
const DAY_MS = 86_400_000;

/** Дата без времени в UTC — аналог datetime.utcnow().date(). */
function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** strftime('%d.%m.%Y') для колонки DATE (в БД лежит полночь UTC). */
function ruDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** Проставляет is_archived=true на чанках документа в Qdrant (вне поиска). */
async function syncArchivedPayload(docId: number): Promise<void> {
  await qdrant().setPayload(COLLECTION, {
    payload: { is_archived: true },
    filter: { must: [{ key: 'document_id', match: { value: docId } }] },
    wait: true,
  });
}

/**
 * Было ли по документу уведомление такого рода за последние `days` дней.
 * Нужно из-за одновременной работы Python-планировщика: пометка в extra
 * страхует от повтора внутри одного бэкенда, а эта проверка — между ними.
 */
async function notifiedRecently(kind: string, docId: number, days: number): Promise<boolean> {
  const since = new Date(Date.now() - days * DAY_MS);
  const found = await prisma.notifications.findFirst({
    where: { kind, document_id: docId, created_at: { gte: since } },
    select: { id: true },
  });
  return found !== null;
}

async function documentsFreshnessJob(job: string): Promise<string> {
  const today = utcToday();
  const docs = await prisma.kb_documents.findMany({
    where: { is_archived: false, status: 'indexed' },
    orderBy: { id: 'asc' },
  });

  let expired = 0;
  let stale = 0;

  for (const doc of docs) {
    try {
      // 1) Истёк срок действия → автоархив + уведомление
      if (doc.effective_to && doc.effective_to < today) {
        await prisma.kb_documents.update({
          where: { id: doc.id },
          data: { is_archived: true },
        });
        try {
          await syncArchivedPayload(doc.id);
        } catch (e) {
          warn(job, `Qdrant archive sync (doc ${doc.id}): ${errText(e)}`);
        }
        // Уведомление могло уже уйти из Python — второй раз не шлём.
        if (!(await notifiedRecently('doc_expired', doc.id, RENOTIFY_DAYS))) {
          await systemNotification({
            kind: 'doc_expired',
            title: doc.title || `Документ #${doc.id}`,
            body:
              `Срок действия истёк ${ruDate(doc.effective_to)} — ` +
              'документ перемещён в архив и исключён из поиска. Загрузите ' +
              'актуальную редакцию или верните из архива вручную.',
            documentId: doc.id,
          });
          expired += 1;
          log(job, `doc_expired: документ ${doc.id} архивирован`);
        }
        continue;
      }

      // 2) Документ старше STALE_YEARS лет → напоминание о проверке
      const base = doc.effective_from ?? doc.created_at ?? null;
      if (!base) continue;
      const baseDay = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
      const ageDays = Math.floor((today.getTime() - baseDay) / DAY_MS);
      if (ageDays < STALE_YEARS * 365) continue;

      const extra = asDict(doc.extra);
      const last = typeof extra.stale_notified_at === 'string' ? extra.stale_notified_at : null;
      if (last) {
        const lastDay = Date.parse(`${last}T00:00:00Z`);
        if (!Number.isNaN(lastDay) && (today.getTime() - lastDay) / DAY_MS < RENOTIFY_DAYS) continue;
      }
      if (await notifiedRecently('doc_stale', doc.id, RENOTIFY_DAYS)) continue;

      const years = Math.floor(ageDays / 365);
      await systemNotification({
        kind: 'doc_stale',
        title: doc.title || `Документ #${doc.id}`,
        body:
          `Документу больше ${years} лет (по документам раздела — срок жизни ` +
          '3–5 лет с обновлением не реже раза в год). Проверьте актуальность ' +
          'и загрузите свежую редакцию, либо укажите «действует до» в метаданных.',
        documentId: doc.id,
      });
      // Пометка в том же поле и формате, что пишет Python, — иначе после
      // отключения одного из бэкендов напоминание пришло бы повторно.
      extra.stale_notified_at = today.toISOString().slice(0, 10);
      await prisma.kb_documents.update({
        where: { id: doc.id },
        data: { extra: extra as Prisma.InputJsonValue },
      });
      stale += 1;
      log(job, `doc_stale: документ ${doc.id} (${ageDays} дн.)`);
    } catch (e) {
      warn(job, `документ ${doc.id}: ${errText(e)}`);
    }
  }

  return `проверено ${docs.length}, архивировано ${expired}, напоминаний ${stale}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Джоб 3: автоудаление ПДн (каждые 10 минут, первый — через 2 мин)
// ═══════════════════════════════════════════════════════════════════════════
//
// Требование ТЗ «персональные данные не храним». TTL — окно, за которое
// пользователь успевает скачать нужный файл из сообщения (PII_TTL_MINUTES в
// backend/services/documents/pii_policy.py). Значение обязано совпадать с
// Python, поэтому по умолчанию берём то же самое.

const PII_TTL_MINUTES = Math.max(1, Number(process.env.PII_TTL_MINUTES || 60));

interface DeletedCounters {
  messages: number;
  docs: number;
  messenger: number;
  dialogues: string[];
}

function counterFor(map: Map<number, DeletedCounters>, userId: number): DeletedCounters {
  let c = map.get(userId);
  if (!c) {
    c = { messages: 0, docs: 0, messenger: 0, dialogues: [] };
    map.set(userId, c);
  }
  return c;
}

/** Удаляет файл с диска, только если он внутри docs/ (path-traversal-safe). */
async function unlinkGenerated(filePath: string | null | undefined): Promise<void> {
  if (!filePath) return;
  const file = resolveInsideDocs(filePath);
  if (!file) return;
  await unlink(file).catch(() => undefined); // missing_ok=True + except OSError
}

/** Сообщения чата с meta.pii_doc, их вложения и документы + пустые диалоги. */
async function cleanupChat(
  job: string,
  cutoff: Date,
  deleted: Map<number, DeletedCounters>
): Promise<void> {
  const candidates = await prisma.chat_messages.findMany({
    where: { created_at: { lt: cutoff }, meta: { not: Prisma.DbNull } },
    orderBy: { id: 'asc' },
  });
  const piiMsgs = candidates.filter((m) => pyBool(asDict(m.meta).pii_doc));
  if (!piiMsgs.length) return;

  // Владелец сообщения = владелец диалога. Тянем цепочку session → dialogue
  // одним запросом вместо db.get() на каждое сообщение.
  const sessionIds = [...new Set(piiMsgs.map((m) => m.session_id))];
  const sessions = await prisma.chat_sessions.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, dialogues: { select: { id: true, user_id: true } } },
  });
  const ownerOf = new Map(sessions.map((s) => [s.id, s.dialogues]));

  const affectedDialogues = new Set<number>();

  for (const m of piiMsgs) {
    const dlg = ownerOf.get(m.session_id) ?? null;
    const ownerId = dlg?.user_id ?? null;
    if (dlg) affectedDialogues.add(dlg.id);

    // Сгенерированный ПДн-документ, прикреплённый к ответу
    if (m.attachment_document_id) {
      const doc = await prisma.my_documents.findUnique({
        where: { id: m.attachment_document_id },
      });
      if (doc) {
        await unlinkGenerated(doc.file_path);
        await prisma.my_documents.delete({ where: { id: doc.id } }).catch(() => undefined);
        if (ownerId) counterFor(deleted, ownerId).docs += 1;
      }
    }

    // Вложения-выгрузки пользователя (исходники с ПДн) — файл и строка.
    // FK стоит на CASCADE, но файлы с диска каскад не удалит.
    const attachments = await prisma.session_documents.findMany({
      where: { message_id: m.id },
      select: { id: true, stored_path: true },
    });
    for (const sd of attachments) await unlinkGenerated(sd.stored_path);
    if (attachments.length) {
      await prisma.session_documents.deleteMany({ where: { message_id: m.id } });
    }

    await prisma.chat_messages.delete({ where: { id: m.id } }).catch(() => undefined);
    if (ownerId) counterFor(deleted, ownerId).messages += 1;
  }

  // Пустые диалоги (нет ни одного сообщения и нет черновика) — удаляем целиком
  for (const dlgId of affectedDialogues) {
    const dlg = await prisma.dialogues.findUnique({ where: { id: dlgId } });
    if (!dlg) continue;
    const hasMsg = await prisma.chat_messages.findFirst({
      where: { chat_sessions: { dialogue_id: dlgId } },
      select: { id: true },
    });
    if (hasMsg === null && !(dlg.draft || '').trim()) {
      counterFor(deleted, dlg.user_id).dialogues.push(dlg.title || 'Без названия');
      await prisma.dialogues.delete({ where: { id: dlgId } }).catch(() => undefined);
    }
  }
  log(job, `чат: удалено сообщений ${piiMsgs.length}`);
}

/** ПДн-документы без сообщения чата (созданы с главной страницы). */
async function cleanupOrphanDocs(
  job: string,
  cutoff: Date,
  deleted: Map<number, DeletedCounters>
): Promise<void> {
  const docs = await prisma.my_documents.findMany({
    where: { is_pii: true, created_at: { lt: cutoff } },
    orderBy: { id: 'asc' },
  });
  let removed = 0;
  for (const doc of docs) {
    const referenced = await prisma.chat_messages.findFirst({
      where: { attachment_document_id: doc.id },
      select: { id: true },
    });
    if (referenced) continue; // удалится вместе с сообщением в cleanupChat
    await unlinkGenerated(doc.file_path);
    await prisma.my_documents.delete({ where: { id: doc.id } }).catch(() => undefined);
    counterFor(deleted, doc.user_id).docs += 1;
    removed += 1;
  }
  if (removed) log(job, `осиротевших ПДн-документов удалено: ${removed}`);
}

/** Пересланные в мессенджер ПДн-ответы ассистента (forwarded_meta.pii). */
async function cleanupMessenger(
  job: string,
  cutoff: Date,
  deleted: Map<number, DeletedCounters>
): Promise<void> {
  const candidates = await prisma.user_messages.findMany({
    where: { created_at: { lt: cutoff }, forwarded_meta: { not: Prisma.DbNull } },
    orderBy: { id: 'asc' },
  });
  const piiMsgs = candidates.filter((m) => pyBool(asDict(m.forwarded_meta).pii));
  if (!piiMsgs.length) return;

  for (const m of piiMsgs) {
    // peer_key считаем ДО удаления: получателей общего чата берём из БД.
    const peerKeys = new Map<number, string>();
    for (const uid of await recipientsOf(m)) peerKeys.set(uid, peerKeyOf(m, uid));

    const files = await prisma.user_message_files.findMany({
      where: { message_id: m.id },
      select: { id: true, stored_path: true },
    });
    for (const f of files) {
      const file = resolveInsideUpload(f.stored_path);
      if (file) await unlink(file).catch(() => undefined);
    }

    await prisma.user_messages.delete({ where: { id: m.id } }).catch(() => undefined);
    counterFor(deleted, m.sender_id).messenger += 1;
    for (const [uid, peerKey] of peerKeys) {
      publish(uid, { type: 'user_message_deleted', id: m.id, peer_key: peerKey });
    }
  }
  log(job, `мессенджер: удалено пересылок ${piiMsgs.length}`);
}

/** Адресные системные уведомления затронутым пользователям. */
async function notifyDeleted(deleted: Map<number, DeletedCounters>): Promise<void> {
  for (const [userId, d] of deleted) {
    if (!userId) continue;
    const parts: string[] = [];
    if (d.messages) parts.push(`сообщений в диалогах с ИИ: ${d.messages}`);
    if (d.docs) parts.push(`сгенерированных документов: ${d.docs}`);
    if (d.messenger) parts.push(`пересылок в мессенджере: ${d.messenger}`);
    if (!parts.length && !d.dialogues.length) continue;

    let body =
      'По регламенту документы и переписка с персональными данными не хранятся. Удалено: ' +
      (parts.length ? parts.join(', ') : '—') +
      '.';
    if (d.dialogues.length) {
      const names = d.dialogues.slice(0, 5).map((t) => `«${t}»`).join(', ');
      body += ` Опустевшие диалоги удалены полностью: ${names}.`;
    }

    await systemNotification({
      kind: 'pii_autodeleted',
      userId,
      title: 'Автоудаление данных с ПДн',
      body,
      url: '/',
    });
  }
}

async function piiAutodeleteJob(job: string): Promise<string> {
  const cutoff = new Date(Date.now() - PII_TTL_MINUTES * 60_000);
  const deleted = new Map<number, DeletedCounters>();

  try {
    await cleanupChat(job, cutoff, deleted);
    await cleanupOrphanDocs(job, cutoff, deleted);
    await cleanupMessenger(job, cutoff, deleted);
  } catch (e) {
    // Порт «except → warning»: частично удалённое всё равно надо разослать.
    warn(job, `ошибка: ${errText(e)}`);
  }

  if (deleted.size) await notifyDeleted(deleted);

  const total = [...deleted.values()].reduce(
    (acc, d) => ({
      messages: acc.messages + d.messages,
      docs: acc.docs + d.docs,
      messenger: acc.messenger + d.messenger,
      dialogues: acc.dialogues + d.dialogues.length,
    }),
    { messages: 0, docs: 0, messenger: 0, dialogues: 0 }
  );
  return (
    `TTL ${PII_TTL_MINUTES} мин; пользователей ${deleted.size}, ` +
    `сообщений ${total.messages}, документов ${total.docs}, ` +
    `пересылок ${total.messenger}, диалогов ${total.dialogues}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Джоб 4: прогрев — возобновление зависших индексаций (при старте воркера)
// ═══════════════════════════════════════════════════════════════════════════
//
// Порт куска lifespan из backend/app.py. BM25 в Next строится лениво (при
// первом поиске, см. lib/ml/bm25-index), а вот документы в статусе
// pending/parsing после перезапуска не подхватывает никто — они висят вечно.

// Документ мог начать индексироваться прямо сейчас (загрузка в соседней
// вкладке или на стороне Python). Трогаем только «остывшие» записи.
const STUCK_GRACE_MS = 15 * 60_000;

async function resumeIndexingJob(job: string): Promise<string> {
  const stuck = await prisma.kb_documents.findMany({
    where: { status: { in: ['pending', 'parsing'] }, created_at: { lt: new Date(Date.now() - STUCK_GRACE_MS) } },
    orderBy: { id: 'asc' },
  });

  let resumed = 0;
  let failed = 0;

  for (const d of stuck) {
    const file = d.source_type === 'local' && d.source_uri ? fromDocsPath(d.source_uri) : null;
    if (file && (await exists(file))) {
      if (isNativelyParsable(suffixOf(baseName(file)))) {
        log(job, `возобновляю индексацию документа ${d.id} (${d.title})`);
        await indexPendingFile(d.id, file); // ошибки внутри переводят в failed
        resumed += 1;
        continue;
      }
      // PDF/скан/старый Office разбирает только FastAPI-парсер: молча оставить
      // документ в pending нельзя — редактор должен увидеть причину.
      await prisma.kb_documents.update({
        where: { id: d.id },
        data: {
          status: 'failed',
          error: 'Формат разбирает только FastAPI-парсер (PDF, скан, старый Office) — загрузите файл заново',
        },
      });
      failed += 1;
      continue;
    }
    await prisma.kb_documents.update({
      where: { id: d.id },
      data: { status: 'failed', error: 'Индексация прервана перезапуском сервера' },
    });
    failed += 1;
  }

  return `зависших ${stuck.length}, возобновлено ${resumed}, помечено failed ${failed}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Реестр джобов и защита от повторного запуска
// ═══════════════════════════════════════════════════════════════════════════

const JOBS = {
  'web-sources': refreshWebSourcesJob,
  'documents-freshness': documentsFreshnessJob,
  'pii-cleanup': piiAutodeleteJob,
  'resume-indexing': resumeIndexingJob,
} satisfies Record<string, (job: string) => Promise<string>>;

export type JobName = keyof typeof JOBS;

export const JOB_NAMES = Object.keys(JOBS) as JobName[];

export function isJobName(value: string): value is JobName {
  return Object.prototype.hasOwnProperty.call(JOBS, value);
}

// Реестр запущенного — в globalThis: в dev Next перезагружает модули на каждое
// изменение файла, и модульная переменная обнулилась бы вместе с флагом
// (тот же приём, что у PrismaClient и шины событий).
const globalForJobs = globalThis as unknown as { hrRunningJobs?: Set<string> };
const running: Set<string> = (globalForJobs.hrRunningJobs ??= new Set());

export interface JobResult {
  ok: boolean;
  /** true — джоб уже выполнялся, повторный запуск пропущен. */
  skipped?: boolean;
  detail: string;
  ms: number;
}

/**
 * Запуск джоба с защитой от наложения. Долгий проход (обход веб-источников с
 * эмбеддингами) легко переживает свой интервал, а два параллельных прохода
 * дали бы дубли документов и двойные уведомления.
 *
 * Защита действует в пределах ПРОЦЕССА — и этого достаточно: и воркер, и
 * внешний планировщик ходят в один и тот же инстанс Next через HTTP.
 * Межпроцессный лок в БД сделать нельзя (advisory-локи Postgres привязаны к
 * соединению, а Prisma отдаёт соединения из пула), поэтому от одновременной
 * работы Python-планировщика страхуют идемпотентные проверки на уровне записей:
 * пометка extra.stale_notified_at, флаг is_archived и поиск уже созданного
 * уведомления по (kind, document_id).
 */
export async function runJob(name: JobName): Promise<JobResult> {
  if (running.has(name)) {
    log(name, 'пропуск: предыдущий запуск ещё не завершился');
    return { ok: true, skipped: true, detail: 'уже выполняется', ms: 0 };
  }
  running.add(name);
  const started = Date.now();
  log(name, 'старт');
  try {
    const detail = await JOBS[name](name);
    const ms = Date.now() - started;
    log(name, `готово за ${ms} мс — ${detail}`);
    return { ok: true, detail, ms };
  } catch (e) {
    const ms = Date.now() - started;
    warn(name, `упал за ${ms} мс: ${errText(e)}`);
    return { ok: false, detail: errText(e), ms };
  } finally {
    running.delete(name);
  }
}
