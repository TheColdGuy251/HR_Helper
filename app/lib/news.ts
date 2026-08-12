import 'server-only';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { isoUtc, prisma } from './db';

// Общая логика домена «Новости» — порт вспомогательных функций
// backend/routes/news.py (_post_dict, _preview, _poll_edit_dict, _poll_state,
// _author_name, _resolve_attachments, _bind_media, _save_poll).
// Вынесена сюда, потому что её делят между собой пять route-handler'ов.

// ── пути к файлам ──────────────────────────────────────────────────────────
// Файлы новостей лежат там же, где их кладёт FastAPI: backend/docs/news.
// Иначе старые и новые вложения окажутся в разных каталогах и часть
// медиа перестанет открываться. process.cwd() в Next — корень app/.

const BACKEND_DIR = process.env.BACKEND_DIR
  ? path.resolve(process.env.BACKEND_DIR)
  : path.resolve(process.cwd(), '..', 'backend');

export const DOCS_DIR = path.join(BACKEND_DIR, 'docs');
export const NEWS_DIR = path.join(DOCS_DIR, 'news');

/**
 * Абсолютный путь к файлу, если он внутри docs_dir (аналог resolve() +
 * relative_to() в Python). Иначе null — наружу отдавать/удалять нельзя.
 * На Windows сравниваем без учёта регистра, как это делает pathlib.
 *
 * В БД пути хранятся относительно docs_dir — так переезд или переименование
 * каталога проекта не ломает ссылки. Абсолютные значения (записи старых
 * версий) тоже принимаются.
 */
export function resolveInsideDocs(stored: string): string | null {
  if (!stored) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(stored)) return null; // URL — не файл
  const target = path.isAbsolute(stored) ? path.resolve(stored) : path.resolve(DOCS_DIR, stored);
  const root = path.resolve(DOCS_DIR);
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const a = norm(target);
  const b = norm(root);
  if (a === b) return target;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) ? target : null;
}

/** Абсолютный fs-путь по хранимому значению (без проверки принадлежности). */
export function fromDocsPath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.resolve(DOCS_DIR, stored);
}

/**
 * Вид пути для записи в БД: относительный к docs_dir. Значение вне docs_dir
 * (в том числе URL или уже относительный путь) возвращается как есть.
 */
export function toDocsPath(p: string): string {
  if (!p || !path.isAbsolute(p)) return p;
  const inside = resolveInsideDocs(p);
  return inside ? path.relative(path.resolve(DOCS_DIR), inside) : p;
}

// ── строковые утилиты в стиле pathlib/pydantic ─────────────────────────────

/** Обрезка по кодовым точкам — Python режет строки так же, а не по UTF-16. */
export function cut(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join('');
}

/** Имя файла без каталогов (Path(...).name, оба вида разделителей). */
export function baseName(filename: string): string {
  const parts = filename.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** Расширение по правилам Path.suffix: у «.gitignore» и «file.» его нет. */
export function suffixOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i) : '';
}

/** Имя без расширения (Path.stem). */
export function stemOf(name: string): string {
  const suffix = suffixOf(name);
  return suffix ? name.slice(0, name.length - suffix.length) : name;
}

// ── ошибки в формате FastAPI ───────────────────────────────────────────────

/** RequestValidationError FastAPI: 422 со списком detail. */
export function validationError(
  loc: (string | number)[],
  type: string,
  msg: string,
  input: unknown
): NextResponse {
  return NextResponse.json({ detail: [{ type, loc, msg, input }] }, { status: 422 });
}

/** Числовой параметр пути: нечисловой сегмент FastAPI отвергает с 422. */
export function parseIntParam(
  raw: string,
  name: string
): { value: number } | { response: NextResponse } {
  if (!/^[+-]?\d+$/.test(raw)) {
    return {
      response: validationError(
        ['path', name],
        'int_parsing',
        'Input should be a valid integer, unable to parse string as an integer',
        raw
      ),
    };
  }
  return { value: Number.parseInt(raw, 10) };
}

// ── типы ответов ───────────────────────────────────────────────────────────

// Именно type, а не interface: только у псевдонима типа есть неявная
// индексная сигнатура, без которой массив не подходит под Prisma.InputJsonValue.
export type AttachmentDict = {
  media_id: number;
  name: string;
  size: number;
  is_image: boolean;
  url: string;
};

export interface PollDraft {
  question: string;
  description: string;
  allow_multiple: boolean;
  show_voters: boolean;
  options: string[];
}

export interface PostDict {
  id: number;
  title: string;
  body_html: string;
  attachments: unknown[];
  preview_image: string | null;
  excerpt: string;
  poll: PollDraft | null;
  author: string;
  is_pinned: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface PollVoterDict {
  name: string;
  initials: string;
}

export interface PollOptionDict {
  id: number;
  text: string;
  votes: number;
  mine: boolean;
  voters: PollVoterDict[];
}

export interface PollStateDict {
  id: number;
  question: string;
  description: string | null;
  allow_multiple: boolean;
  show_voters: boolean;
  total_votes: number;
  options: PollOptionDict[];
}

export interface PostRow {
  id: number;
  title: string;
  body_html: string;
  attachments: unknown;
  author_id: number | null;
  is_pinned: boolean;
  created_at: Date;
  updated_at: Date | null;
}

// ── превью ─────────────────────────────────────────────────────────────────

const IMG_SRC_RE = /<img[^>]+src="([^"]+)"/i;
const TAG_RE = /<[^>]+>/g;

/** Первая картинка (для обложки) + текстовая выжимка (для превью в ленте). */
export function preview(bodyHtml: string): [string | null, string] {
  const m = IMG_SRC_RE.exec(bodyHtml || '');
  const img = m ? m[1] : null;
  const text = (bodyHtml || '').replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  const excerpt = chars.slice(0, 200).join('') + (chars.length > 200 ? '…' : '');
  return [img, excerpt];
}

// ── сборка ответа по посту ─────────────────────────────────────────────────

function fullNameOf(u: { surname: string; name: string; patronymic: string | null }): string {
  return [u.surname, u.name, u.patronymic || ''].filter(Boolean).join(' ').trim();
}

function initialsOf(u: { surname: string; name: string }): string {
  const first = (u.name || '').trim().slice(0, 1);
  const last = (u.surname || '').trim().slice(0, 1);
  return (last + first).toUpperCase();
}

/**
 * _post_dict для набора постов сразу: авторы и голосования подтягиваются
 * пакетно (в Python на каждый пост шёл отдельный запрос — результат тот же).
 */
export async function postDicts(posts: PostRow[]): Promise<PostDict[]> {
  if (!posts.length) return [];

  const authorIds = [...new Set(posts.map((p) => p.author_id).filter((v): v is number => !!v))];
  const authors = authorIds.length
    ? await prisma.users.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, surname: true, name: true, patronymic: true },
      })
    : [];
  const nameById = new Map<number, string>(authors.map((u) => [u.id, fullNameOf(u)]));

  const polls = await prisma.news_polls.findMany({
    where: { post_id: { in: posts.map((p) => p.id) } },
    orderBy: { id: 'asc' },
    include: { news_poll_options: { orderBy: { position: 'asc' } } },
  });
  const pollByPost = new Map<number, PollDraft>();
  for (const poll of polls) {
    if (pollByPost.has(poll.post_id)) continue; // как .first() в Python — берём один
    pollByPost.set(poll.post_id, {
      question: poll.question,
      description: poll.description || '',
      allow_multiple: poll.allow_multiple,
      show_voters: poll.show_voters,
      options: poll.news_poll_options.map((o) => o.text),
    });
  }

  return posts.map((p) => {
    const [previewImage, excerpt] = preview(p.body_html);
    const attachments = Array.isArray(p.attachments) ? p.attachments : [];
    return {
      id: p.id,
      title: p.title,
      body_html: p.body_html,
      attachments,
      preview_image: previewImage,
      excerpt,
      poll: pollByPost.get(p.id) ?? null, // для префилла редактора
      author: (p.author_id && nameById.get(p.author_id)) || '—',
      is_pinned: p.is_pinned,
      created_at: isoUtc(p.created_at),
      updated_at: isoUtc(p.updated_at),
    };
  });
}

export async function postDict(post: PostRow): Promise<PostDict> {
  const [dict] = await postDicts([post]);
  return dict;
}

// ── вложения и привязка медиа ──────────────────────────────────────────────

/**
 * По списку от клиента берём media_id, перепроверяем существование в БД и
 * собираем достоверные метаданные (имя/размер/url с сервера, не с клиента).
 */
export async function resolveAttachments(raw: unknown): Promise<AttachmentDict[]> {
  if (!Array.isArray(raw) || !raw.length) return [];

  const ids: number[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = (item as Record<string, unknown>).media_id;
    const id =
      typeof value === 'number'
        ? Math.trunc(value)
        : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())
          ? Number.parseInt(value, 10)
          : 0;
    if (!id) continue;
    ids.push(id);
  }
  if (!ids.length) return [];

  const media = await prisma.news_media.findMany({ where: { id: { in: [...new Set(ids)] } } });
  const byId = new Map(media.map((m) => [m.id, m] as const));

  const out: AttachmentDict[] = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) continue;
    out.push({
      media_id: m.id,
      name: m.original_name,
      size: m.size,
      is_image: m.is_image,
      url: `/api/news/media/${m.id}`,
    });
  }
  return out;
}

/**
 * Привязываем к посту media из вложений и встроенные в текст картинки/документы —
 * чтобы при удалении поста файлы удалились каскадом.
 */
export async function bindMedia(
  postId: number,
  attachments: AttachmentDict[],
  bodyHtml: string
): Promise<void> {
  const ids = new Set<number>();
  for (const a of attachments) {
    if (a.media_id) ids.add(a.media_id);
  }
  for (const m of (bodyHtml || '').matchAll(/\/api\/news\/media\/(\d+)/g)) {
    ids.add(Number.parseInt(m[1], 10));
  }
  if (!ids.size) return;
  // post_id: null — привязываем только «ничьи» медиа, как в Python.
  await prisma.news_media.updateMany({
    where: { id: { in: [...ids] }, post_id: null },
    data: { post_id: postId },
  });
}

// ── голосования ────────────────────────────────────────────────────────────

export interface PollPayload {
  question: string;
  description: string | null;
  allow_multiple: boolean;
  show_voters: boolean;
  options: string[];
}

/**
 * Создаёт/заменяет голосование поста. null или <2 вариантов — удаляет.
 * Замена сбрасывает прежние голоса (каскадом).
 */
export async function savePoll(postId: number, pp: PollPayload | null): Promise<void> {
  const existing = await prisma.news_polls.findFirst({
    where: { post_id: postId },
    orderBy: { id: 'asc' },
  });
  const opts = (pp?.options ?? []).map((o) => o.trim()).filter((o) => o);
  if (!pp || !pp.question.trim() || opts.length < 2) {
    if (existing) await prisma.news_polls.delete({ where: { id: existing.id } });
    return;
  }

  const q = cut(pp.question.trim(), 300);
  const desc = (pp.description || '').trim() || null;
  const trimmed = opts.slice(0, 12).map((o) => cut(o, 300));

  if (existing) {
    const curOpts = await prisma.news_poll_options.findMany({
      where: { poll_id: existing.id },
      orderBy: { position: 'asc' },
      select: { text: true },
    });
    const unchanged =
      existing.question === q &&
      existing.description === desc &&
      existing.allow_multiple === pp.allow_multiple &&
      existing.show_voters === pp.show_voters &&
      curOpts.length === trimmed.length &&
      curOpts.every((o, i) => o.text === trimmed[i]);
    if (unchanged) return; // опрос не изменился — сохраняем голоса
    await prisma.news_polls.delete({ where: { id: existing.id } });
  }

  const poll = await prisma.news_polls.create({
    data: {
      post_id: postId,
      question: q,
      description: desc,
      allow_multiple: pp.allow_multiple,
      show_voters: pp.show_voters,
    },
  });
  await prisma.news_poll_options.createMany({
    data: trimmed.map((text, i) => ({ poll_id: poll.id, text, position: i })),
  });
}

export interface PollRow {
  id: number;
  question: string;
  description: string | null;
  allow_multiple: boolean;
  show_voters: boolean;
}

/** Состояние голосования для конкретного пользователя (_poll_state). */
export async function pollState(poll: PollRow, userId: number): Promise<PollStateDict> {
  const options = await prisma.news_poll_options.findMany({
    where: { poll_id: poll.id },
    orderBy: { position: 'asc' },
  });
  const votes = await prisma.news_poll_votes.findMany({
    where: { poll_id: poll.id },
    orderBy: { id: 'asc' },
  });

  const byOpt = new Map<number, number[]>();
  for (const v of votes) {
    const list = byOpt.get(v.option_id);
    if (list) list.push(v.user_id);
    else byOpt.set(v.option_id, [v.user_id]);
  }
  const mine = new Set(votes.filter((v) => v.user_id === userId).map((v) => v.option_id));

  // Имена голосовавших нужны только в открытом опросе.
  const voterById = new Map<number, PollVoterDict>();
  if (poll.show_voters) {
    const uids = [...new Set(votes.map((v) => v.user_id))];
    if (uids.length) {
      const users = await prisma.users.findMany({
        where: { id: { in: uids } },
        select: { id: true, surname: true, name: true, patronymic: true },
      });
      for (const u of users) {
        voterById.set(u.id, { name: fullNameOf(u), initials: initialsOf(u) });
      }
    }
  }

  return {
    id: poll.id,
    question: poll.question,
    description: poll.description,
    allow_multiple: poll.allow_multiple,
    show_voters: poll.show_voters,
    total_votes: votes.length,
    options: options.map((o) => {
      const uids = byOpt.get(o.id) ?? [];
      return {
        id: o.id,
        text: o.text,
        votes: uids.length,
        mine: mine.has(o.id),
        voters: poll.show_voters
          ? uids.map((uid) => voterById.get(uid)).filter((v): v is PollVoterDict => !!v)
          : [],
      };
    }),
  };
}

// ── разбор тела запроса (PostPayload) ──────────────────────────────────────

export interface PostPayload {
  title: string;
  body_html: string;
  attachments: unknown;
  is_pinned: boolean;
  poll: PollPayload | null;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function parsePoll(raw: unknown): PollPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    question: asString(o.question),
    description: typeof o.description === 'string' ? o.description : null,
    allow_multiple: Boolean(o.allow_multiple),
    show_voters: Boolean(o.show_voters),
    options: Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** Значения по умолчанию — как у PostPayload/PollPayload (pydantic). */
export function parsePostPayload(raw: unknown): PostPayload {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    title: asString(o.title),
    body_html: asString(o.body_html),
    attachments: o.attachments ?? null,
    is_pinned: Boolean(o.is_pinned),
    poll: parsePoll(o.poll),
  };
}
