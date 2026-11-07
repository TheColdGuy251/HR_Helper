import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireUser } from '@/lib/auth';
import { asUuid } from '@/lib/ids';
import { MESSAGE_SELECT, messageItems } from '@/lib/chat';

// Переключение между вариантами ответа (< i/n >) и между ветками правок вопроса.
//
// У ответа ассистента обычно достаточно заменить один пузырь, но если после
// старого варианта уже шли новые сообщения, меняется вся видимая ветка - тогда
// фронтенду возвращается флаг reload и он перезагружает список целиком.

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  let body: { dialogue_id?: unknown; message_id?: unknown; direction?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest('Ожидается JSON');
  }

  const dialogueId = asUuid(body.dialogue_id);
  const messageId = asUuid(body.message_id);
  const direction = Number(body.direction ?? 0) || 0;
  if (!dialogueId || !messageId) return notFound('Сообщение не найдено');

  // Диалог должен принадлежать текущему пользователю.
  const dialogue = await prisma.dialogues.findUnique({
    where: { id: dialogueId },
    select: { id: true, user_id: true },
  });
  if (!dialogue || dialogue.user_id !== user.id) return notFound('Диалог не найден');

  const cur = await prisma.chat_messages.findUnique({
    where: { id: messageId },
    select: { id: true, dialogue_id: true, role: true, variant_group: true },
  });
  if (!cur || cur.dialogue_id !== dialogue.id) return notFound('Сообщение не найдено');

  // Группа вариантов: у первого сообщения группы её идентификатором служит его же id.
  const group = cur.variant_group ?? cur.id;
  const variants = await prisma.chat_messages.findMany({
    where: { dialogue_id: dialogue.id, variant_group: group, role: cur.role },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  const list = variants.length ? variants : [{ id: cur.id }];

  const idx = Math.max(
    0,
    list.findIndex((v) => v.id === cur.id)
  );
  const newIdx = Math.max(0, Math.min(idx + direction, list.length - 1));
  const target = list[newIdx];

  // Активным остаётся ровно один вариант - по нему собирается видимая ветка.
  await prisma.$transaction([
    prisma.chat_messages.updateMany({
      where: { id: { in: list.map((v) => v.id) } },
      data: { variant_active: false },
    }),
    prisma.chat_messages.update({
      where: { id: target.id },
      data: { variant_active: true },
    }),
  ]);

  // Правка вопроса меняет весь дальнейший ход разговора.
  if (cur.role === 'user') {
    return NextResponse.json({ success: true, role: 'user', reload: true });
  }

  // У вариантов ответа могли быть "продолжения" - вопросы, заданные после
  // старого варианта до повторной генерации. Тогда точечной замены мало.
  const groupIds = new Set(list.map((v) => v.id));
  const after = await prisma.chat_messages.findMany({
    where: { dialogue_id: dialogue.id, id: { gt: list[0].id } },
    select: { id: true },
  });
  if (after.some((row) => !groupIds.has(row.id))) {
    return NextResponse.json({ success: true, role: 'assistant', reload: true });
  }

  const row = await prisma.chat_messages.findUnique({
    where: { id: target.id },
    select: MESSAGE_SELECT,
  });
  if (!row) return notFound('Сообщение не найдено');

  const [item] = await messageItems([row]);
  item.variant_group = group;
  item.variant_index = newIdx + 1;
  item.variant_count = list.length;

  return NextResponse.json({ success: true, role: 'assistant', message: item });
}
