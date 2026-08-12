import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, requireKbEditor, requireUser } from '@/lib/auth';
import { sanitizeHtml } from '@/lib/htmlsanitize';
import {
  bindMedia,
  parsePostPayload,
  postDict,
  postDicts,
  resolveAttachments,
  savePoll,
  validationError,
} from '@/lib/news';

// Лента новостей и создание поста.
// Порт GET/POST /api/news из backend/routes/news.py (list_news, create_post).

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const posts = await prisma.news_posts.findMany({
    where: { is_published: true },
    orderBy: [{ is_pinned: 'desc' }, { created_at: 'desc' }],
  });

  return NextResponse.json({
    success: true,
    can_edit: Boolean(gate.user.is_admin || gate.user.is_kb_editor),
    items: await postDicts(posts),
  });
}

export async function POST(request: NextRequest) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return validationError(['body'], 'json_invalid', 'JSON decode error', null);
  }

  const payload = parsePostPayload(raw);
  const title = payload.title.trim();
  const body = sanitizeHtml(payload.body_html);
  const attachments = await resolveAttachments(payload.attachments);
  if (!title && !body && !attachments.length) return badRequest('Пустая новость');

  const post = await prisma.news_posts.create({
    data: {
      title: title || 'Без заголовка',
      body_html: body,
      // Пустой список в БД хранится как NULL — так же, как `attachments or None`.
      attachments: attachments.length ? attachments : Prisma.DbNull,
      author_id: gate.user.id,
      is_published: true,
      is_pinned: payload.is_pinned,
    },
  });

  await bindMedia(post.id, attachments, post.body_html);
  await savePoll(post.id, payload.poll);

  return NextResponse.json({ success: true, post: await postDict(post) });
}
