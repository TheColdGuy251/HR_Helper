import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, fullName, initials, notFound, requireUser } from '@/lib/auth';
import { asDict, baseName, isFile, pyBool, suffixOf } from '@/lib/kb';
import {
  GENERAL_KEY,
  UPLOAD_DIR,
  bodyParams,
  broadcastMessage,
  forwardSnapshot,
  markRead,
  messageById,
  serializeMessage,
  threadWhere,
  userById,
  type FileRow,
} from '@/lib/messenger';

// Отправка сообщения (в т.ч. пересылка ответа ассистента и сообщений чата).

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const peerId = p.optUuid('peer_id');
  const general = p.bool('general', false);
  let content = p.str('content', '').trim();
  const forwardMessageId = p.optUuid('forward_message_id');
  const forwardUserMessageId = p.optUuid('forward_user_message_id');
  const replyToId = p.optUuid('reply_to_id');
  const attachmentIds = p.optUuidList('attachment_ids') ?? [];
  const invalid = p.invalid();
  if (invalid) return invalid;

  let forwardedMeta: Record<string, unknown> | null = null;
  let forwardSrcId: string | null = null; // для переноса вложений при пересылке

  if (forwardMessageId !== null) {
    // Пересылка сообщения ИИ-ассистента (из чата).
    forwardedMeta = await forwardSnapshot(forwardMessageId);
    if (forwardedMeta === null) return notFound('Пересылаемое сообщение не найдено');
  } else if (forwardUserMessageId !== null) {
    // Пересылка сообщения мессенджера дальше.
    const src = await messageById(forwardUserMessageId);
    if (!src) return notFound('Пересылаемое сообщение не найдено');
    forwardSrcId = src.id;
    const sfm = asDict(src.forwarded_meta);
    if (pyBool(sfm.ai) || pyBool(sfm.content)) {
      forwardedMeta = sfm; // снимок ответа ассистента - переносим как есть
    } else {
      // обычное сообщение -> помечаем, ОТ кого переслано (исходный автор).
      let origin: unknown;
      if (pyBool(sfm.from_user)) {
        origin = sfm.from_user; // уже пересланное - сохраняем автора
      } else {
        const origUser = await userById(src.sender_id);
        origin = origUser
          ? { id: origUser.id, name: fullName(origUser), initials: initials(origUser) }
          : { name: '—', initials: '?' };
      }
      forwardedMeta = { from_user: origin };
      if (!content) content = (src.content || '').trim();
    }
  }

  // свои загруженные, ещё не привязанные файлы
  const pendingFiles: FileRow[] = attachmentIds.length
    ? await prisma.user_message_files.findMany({
        where: { id: { in: attachmentIds }, owner_id: me.id, message_id: null },
      })
    : [];

  if (!content && forwardedMeta === null && !pendingFiles.length) {
    return badRequest('Пустое сообщение');
  }

  if (!general) {
    // peer_id == user.id - это "Заметки" (диалог с собой), разрешено.
    if (!peerId || !(await userById(peerId))) return notFound('Получатель не найден');
  }

  const replyTo = replyToId && (await messageById(replyToId)) ? replyToId : null;
  const msg = await prisma.user_messages.create({
    data: {
      sender_id: me.id,
      recipient_id: general ? null : peerId,
      is_general: general,
      content,
      forwarded_meta:
        forwardedMeta === null ? Prisma.DbNull : (forwardedMeta as Prisma.InputJsonValue),
      reply_to_id: replyTo,
    },
  });

  if (pendingFiles.length) {
    await prisma.user_message_files.updateMany({
      where: { id: { in: pendingFiles.map((f) => f.id) } },
      data: { message_id: msg.id },
    });
  }

  // Пересылка вложений: дублируем файлы исходного сообщения (копии на диске).
  if (forwardSrcId !== null) {
    await mkdir(UPLOAD_DIR, { recursive: true });
    const srcFiles = await prisma.user_message_files.findMany({
      where: { message_id: forwardSrcId },
      orderBy: { id: 'asc' },
    });
    const copies: Prisma.user_message_filesCreateManyInput[] = [];
    for (const sf of srcFiles) {
      try {
        if (!(await isFile(sf.stored_path))) continue;
        const ext = suffixOf(baseName(sf.stored_path)).toLowerCase();
        const newPath = path.join(UPLOAD_DIR, `${randomUUID().replace(/-/g, '')}${ext}`);
        await copyFile(sf.stored_path, newPath);
        copies.push({
          message_id: msg.id,
          owner_id: me.id,
          original_name: sf.original_name,
          stored_path: newPath,
          content_type: sf.content_type,
          size_bytes: sf.size_bytes,
          is_image: sf.is_image,
          img_w: sf.img_w,
          img_h: sf.img_h,
        });
      } catch {
        // Ошибка файловой системы проглатывается - файл просто не переносится
      }
    }
    if (copies.length) await prisma.user_message_files.createMany({ data: copies });
  }

  // Отправитель сразу считает своё сообщение прочитанным в этом диалоге.
  const where = threadWhere(me.id, peerId, general);
  await markRead(me.id, general || !peerId ? GENERAL_KEY : peerId, where);

  await broadcastMessage(msg);
  return NextResponse.json(await serializeMessage(msg, me.id));
}
