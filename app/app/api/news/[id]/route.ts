import { unlink } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { notFound, requireKbEditor } from '@/lib/auth';
import { sanitizeHtml } from '@/lib/htmlsanitize';
import {
  bindMedia,
  parseIntParam,
  parsePostPayload,
  postDict,
  resolveAttachments,
  resolveInsideDocs,
  savePoll,
  validationError,
} from '@/lib/news';

// Правка и удаление новости.
// Порт PATCH/DELETE /api/news/{post_id} из backend/routes/news.py.

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parseIntParam((await params).id, 'post_id');
  if ('response' in parsed) return parsed.response;
  const postId = parsed.value;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return validationError(['body'], 'json_invalid', 'JSON decode error', null);
  }

  const post = await prisma.news_posts.findUnique({ where: { id: postId } });
  if (!post) return notFound('Новость не найдена');

  const payload = parsePostPayload(raw);
  const body = sanitizeHtml(payload.body_html);
  const attachments = await resolveAttachments(payload.attachments);

  const updated = await prisma.news_posts.update({
    where: { id: postId },
    data: {
      title: payload.title.trim() || 'Без заголовка',
      body_html: body,
      attachments: attachments.length ? attachments : Prisma.DbNull,
      is_pinned: payload.is_pinned,
      updated_at: new Date(),
    },
  });

  await bindMedia(postId, attachments, body);
  await savePoll(postId, payload.poll);

  return NextResponse.json({ success: true, post: await postDict(updated) });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const gate = await requireKbEditor();
  if ('response' in gate) return gate.response;

  const parsed = parseIntParam((await params).id, 'post_id');
  if ('response' in parsed) return parsed.response;
  const postId = parsed.value;

  const post = await prisma.news_posts.findUnique({ where: { id: postId } });
  if (!post) return notFound('Новость не найдена');

  // Удаляем файлы привязанных media с диска (каскад в БД снесёт записи).
  const media = await prisma.news_media.findMany({ where: { post_id: postId } });
  for (const m of media) {
    const file = resolveInsideDocs(m.stored_path);
    if (!file) continue; // путь вне docs — трогать чужие файлы нельзя
    try {
      await unlink(file);
    } catch {
      /* файла уже нет или занят — запись всё равно уйдёт каскадом */
    }
  }

  await prisma.news_posts.delete({ where: { id: postId } });
  return NextResponse.json({ success: true });
}
