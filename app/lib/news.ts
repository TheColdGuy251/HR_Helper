import 'server-only';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { news_media, news_posts, polls } from '@prisma/client';
import { isoUtc, prisma } from './db';
import { asUuid } from './ids';

// Общая логика домена "Новости": сериализация постов, превью, опросы, автор,
// вложения. Её делят между собой пять route-handler'ов.

// Пути к файлам
// Файлы новостей лежат в backend/docs/news. process.cwd() в Next - корень
// frontend/.

const BACKEND_DIR = process.env.BACKEND_DIR
  ? path.resolve(process.env.BACKEND_DIR)
  : path.resolve(process.cwd(), '..', 'backend');

export const DOCS_DIR = path.join(BACKEND_DIR, 'docs');
export const NEWS_DIR = path.join(DOCS_DIR, 'news');

/**
 * Абсолютный путь к файлу, если он внутри docs_dir, иначе null - наружу
 * отдавать и удалять нельзя. На Windows сравниваем без учёта регистра.
 */
export function resolveInsideDocs(stored: string): string | null {
  if (!stored) return null;
  const target = path.resolve(stored);
  const root = path.resolve(DOCS_DIR);
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const a = norm(target);
  const b = norm(root);
  if (a === b) return target;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) ? target : null;
}

// Строковые утилиты

/** Обрезка по кодовым точкам, а не по UTF-16: суррогатные пары не разрываются. */
export function cut(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join('');
}

/** Имя файла без каталогов (Path(...).name, оба вида разделителей). */
export function baseName(filename: string): string {
  const parts = filename.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** Расширение по правилам Path.suffix: у ".gitignore" и "file." его нет. */
export function suffixOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i) : '';
}

/** Имя без расширения (Path.stem). */
export function stemOf(name: string): string {
  const suffix = suffixOf(name);
  return suffix ? name.slice(0, name.length - suffix.length) : name;
}

// Ошибки валидации

/** 422 со списком detail. */
export function validationError(
  loc: (string | number)[],
  type: string,
  msg: string,
  input: unknown
): NextResponse {
  return NextResponse.json({ detail: [{ type, loc, msg, input }] }, { status: 422 });
}

/** 422 на некорректный UUID для поля типа UUID. */
export function uuidError(loc: (string | number)[], input: unknown): NextResponse {
  return validationError(loc, 'uuid_parsing', 'Input should be a valid UUID', input);
}

/** Идентификатор записи в пути (UUID). */
export function parseIdParam(
  raw: string,
  name: string
): { value: string } | { response: NextResponse } {
  const id = asUuid(raw);
  return id ? { value: id } : { response: uuidError(['path', name], raw) };
}

// типы ответов

export type AttachmentDict = {
  media_id: string;
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
  id: string;
  title: string;
  body_html: string;
  attachments: AttachmentDict[];
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
  id: string;
  text: string;
  votes: number;
  mine: boolean;
  voters: PollVoterDict[];
}

export interface PollStateDict {
  id: string;
  question: string;
  description: string | null;
  allow_multiple: boolean;
  show_voters: boolean;
  total_votes: number;
  options: PollOptionDict[];
}

export type PostRow = news_posts;

// превью

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

// сборка ответа по посту

function fullNameOf(u: { surname: string; name: string; patronymic: string | null }): string {
  return [u.surname, u.name, u.patronymic || ''].filter(Boolean).join(' ').trim();
}

function initialsOf(u: { surname: string; name: string }): string {
  const first = (u.name || '').trim().slice(0, 1);
  const last = (u.surname || '').trim().slice(0, 1);
  return (last + first).toUpperCase();
}

function attachmentDict(m: news_media): AttachmentDict {
  return {
    media_id: m.id,
    name: m.original_name,
    size: m.size,
    is_image: m.is_image,
    url: `/api/news/media/${m.id}`,
  };
}

/**
 * Сериализация набора постов сразу: авторы, вложения и голосования
 * подтягиваются пакетно.
 */
export async function postDicts(posts: PostRow[]): Promise<PostDict[]> {
  if (!posts.length) return [];
  const postIds = posts.map((p) => p.id);

  const authorIds = [...new Set(posts.map((p) => p.author_id).filter((v): v is string => !!v))];
  const [authors, pollRows, media] = await Promise.all([
    authorIds.length
      ? prisma.users.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, surname: true, name: true, patronymic: true },
        })
      : Promise.resolve([]),
    prisma.polls.findMany({
      where: { post_id: { in: postIds } },
      include: { options: { orderBy: { position: 'asc' } } },
    }),
    // Вложения поста - файлы с номером в списке; встроенные в текст - без номера.
    prisma.news_media.findMany({
      where: { post_id: { in: postIds }, attachment_order: { not: null } },
      orderBy: { attachment_order: 'asc' },
    }),
  ]);
  const nameById = new Map<string, string>(authors.map((u) => [u.id, fullNameOf(u)]));

  const pollByPost = new Map<string, PollDraft>();
  for (const poll of pollRows) {
    if (!poll.post_id) continue;
    pollByPost.set(poll.post_id, {
      question: poll.question,
      description: poll.description || '',
      allow_multiple: poll.allow_multiple,
      show_voters: poll.show_voters,
      options: poll.options.map((o) => o.text),
    });
  }

  const attachmentsByPost = new Map<string, AttachmentDict[]>();
  for (const m of media) {
    if (!m.post_id) continue;
    const list = attachmentsByPost.get(m.post_id);
    if (list) list.push(attachmentDict(m));
    else attachmentsByPost.set(m.post_id, [attachmentDict(m)]);
  }

  return posts.map((p) => {
    const [previewImage, excerpt] = preview(p.body_html);
    return {
      id: p.id,
      title: p.title,
      body_html: p.body_html,
      attachments: attachmentsByPost.get(p.id) ?? [],
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

// вложения и привязка медиа

/**
 * По списку от клиента берём media_id, перепроверяем существование в БД и
 * собираем достоверные метаданные (имя/размер/url с сервера, не с клиента).
 */
export async function resolveAttachments(raw: unknown): Promise<AttachmentDict[]> {
  if (!Array.isArray(raw) || !raw.length) return [];

  const ids: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = asUuid((item as Record<string, unknown>).media_id);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return [];

  const media = await prisma.news_media.findMany({ where: { id: { in: ids } } });
  const byId = new Map(media.map((m) => [m.id, m] as const));
  return ids.flatMap((id) => {
    const m = byId.get(id);
    return m ? [attachmentDict(m)] : [];
  });
}

const MEDIA_URL_RE = /\/api\/news\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/**
 * Привязываем к посту media из вложений и встроенные в текст картинки/документы -
 * чтобы при удалении поста файлы удалились каскадом - и заново нумеруем список
 * вложений поста.
 */
export async function bindMedia(
  postId: string,
  attachments: AttachmentDict[],
  bodyHtml: string
): Promise<void> {
  const attachIds = attachments.map((a) => a.media_id);
  const ids = new Set(attachIds);
  for (const m of (bodyHtml || '').matchAll(MEDIA_URL_RE)) {
    const id = asUuid(m[1]);
    if (id) ids.add(id);
  }

  await prisma.$transaction(async (tx) => {
    if (ids.size) {
      // post_id: null - привязываем только "ничьи" медиа.
      await tx.news_media.updateMany({
        where: { id: { in: [...ids] }, post_id: null },
        data: { post_id: postId },
      });
    }
    // Файлы, убранные из вложений, остаются привязанными к посту (могут быть
    // встроены в текст), но из списка вложений уходят.
    await tx.news_media.updateMany({
      where: { post_id: postId, attachment_order: { not: null } },
      data: { attachment_order: null },
    });
    for (const [order, id] of attachIds.entries()) {
      await tx.news_media.updateMany({
        where: { id, post_id: postId },
        data: { attachment_order: order },
      });
    }
  });
}

// голосования

export interface PollPayload {
  question: string;
  description: string | null;
  allow_multiple: boolean;
  show_voters: boolean;
  options: string[];
}

/**
 * Создаёт/заменяет голосование поста. null или <2 вариантов - удаляет.
 * Замена сбрасывает прежние голоса (каскадом).
 */
export async function savePoll(postId: string, pp: PollPayload | null): Promise<void> {
  const existing = await prisma.polls.findUnique({
    where: { post_id: postId },
    include: { options: { orderBy: { position: 'asc' }, select: { text: true } } },
  });
  const opts = (pp?.options ?? []).map((o) => o.trim()).filter((o) => o);
  if (!pp || !pp.question.trim() || opts.length < 2) {
    if (existing) await prisma.polls.delete({ where: { id: existing.id } });
    return;
  }

  const q = cut(pp.question.trim(), 300);
  const desc = (pp.description || '').trim() || null;
  const trimmed = opts.slice(0, 12).map((o) => cut(o, 300));

  if (existing) {
    const unchanged =
      existing.question === q &&
      existing.description === desc &&
      existing.allow_multiple === pp.allow_multiple &&
      existing.show_voters === pp.show_voters &&
      existing.options.length === trimmed.length &&
      existing.options.every((o, i) => o.text === trimmed[i]);
    if (unchanged) return; // опрос не изменился - сохраняем голоса
    await prisma.polls.delete({ where: { id: existing.id } });
  }

  // В новостях голос всегда можно снять повторным кликом, ассистент не голосует.
  await prisma.polls.create({
    data: {
      post_id: postId,
      question: q,
      description: desc,
      allow_multiple: pp.allow_multiple,
      show_voters: pp.show_voters,
      allow_change: true,
      allow_bot: false,
      options: { create: trimmed.map((text, i) => ({ text, position: i })) },
    },
  });
}

export type PollRow = Pick<polls, 'id' | 'question' | 'description' | 'allow_multiple' | 'show_voters'>;

/** Состояние голосования для конкретного пользователя. */
export async function pollState(poll: PollRow, userId: string): Promise<PollStateDict> {
  const options = await prisma.poll_options.findMany({
    where: { poll_id: poll.id },
    orderBy: { position: 'asc' },
    include: { votes: { orderBy: { created_at: 'asc' }, select: { user_id: true } } },
  });

  // Имена голосовавших нужны только в открытом опросе.
  const voterById = new Map<string, PollVoterDict>();
  if (poll.show_voters) {
    const uids = [...new Set(options.flatMap((o) => o.votes.map((v) => v.user_id)))];
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
    total_votes: options.reduce((n, o) => n + o.votes.length, 0),
    options: options.map((o) => ({
      id: o.id,
      text: o.text,
      votes: o.votes.length,
      mine: o.votes.some((v) => v.user_id === userId),
      voters: poll.show_voters
        ? o.votes.map((v) => voterById.get(v.user_id)).filter((v): v is PollVoterDict => !!v)
        : [],
    })),
  };
}

// разбор тела запроса (PostPayload)

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

/** Значения по умолчанию для поста и опроса. */
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
