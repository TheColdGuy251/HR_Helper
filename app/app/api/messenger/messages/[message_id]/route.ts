import { unlink } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { forbidden, notFound, requireUser } from '@/lib/auth';
import { asDict, asList, boolQuery, parsePathId, pyBool } from '@/lib/kb';
import { publish } from '@/lib/events';
import { messageById, peerKeyOf, recipientsOf, resolveInsideUpload } from '@/lib/messenger';

// Удаление сообщения: «у себя» (hidden_for) или «для всех».
// Порт DELETE /api/messenger/messages/{message_id} из backend/routes/messenger.py.

type Ctx = { params: Promise<{ message_id: string }> };

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const parsed = parsePathId((await params).message_id, 'message_id');
  if ('response' in parsed) return parsed.response;
  const forAll = boolQuery(request.nextUrl.searchParams.get('for_all'), 'for_all');
  if ('response' in forAll) return forAll.response;

  const msg = await messageById(parsed.value);
  if (!msg) return notFound('Сообщение не найдено');
  const isParticipant = msg.is_general || me === msg.sender_id || me === msg.recipient_id;
  if (!isParticipant) return forbidden('Нет доступа');

  if (!forAll.value) {
    // «Удалить у себя» — можно для любого сообщения диалога (в т.ч. чужого).
    const hidden = asList(msg.hidden_for);
    if (!hidden.includes(me)) {
      await prisma.user_messages.update({
        where: { id: msg.id },
        data: { hidden_for: [...hidden, me] as Prisma.InputJsonValue },
      });
    }
    return NextResponse.json({ ok: true, for_all: false });
  }

  // Системные отметки удаляются только у себя.
  if (pyBool(asDict(msg.forwarded_meta).system)) {
    return forbidden('Системное сообщение можно удалить только у себя');
  }
  // «Удалить для всех» — только своё сообщение.
  if (msg.sender_id !== me) return forbidden('Для всех можно удалять только свои сообщения');

  const recipients = [...new Set(await recipientsOf(msg))];
  const peerKeys = new Map(recipients.map((uid) => [uid, peerKeyOf(msg, uid)]));

  const files = await prisma.user_message_files.findMany({
    where: { message_id: msg.id },
    select: { stored_path: true },
  });
  for (const f of files) {
    const file = resolveInsideUpload(f.stored_path);
    if (!file) continue; // файл вне каталога вложений — не наш, не трогаем
    await unlink(file).catch(() => {}); // missing_ok=True
  }

  // Вложения, реакции и опрос уходят каскадом (ON DELETE CASCADE в БД).
  await prisma.user_messages.delete({ where: { id: msg.id } });

  for (const [uid, pk] of peerKeys) {
    publish(uid, { type: 'user_message_deleted', id: msg.id, peer_key: pk });
  }
  return NextResponse.json({ ok: true, for_all: true });
}
