import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireUser } from '@/lib/auth';
import { asUuid } from '@/lib/ids';
import { uuidError, validationError } from '@/lib/news';
import { collectHistoryBefore, genTextForUserMessage, registerStream, StreamState } from '@/lib/chat';
import { runGeneration } from '@/lib/chat-generate';

// Правка вопроса пользователя -> новая ветка диалога.
//
// Создаём новый вариант вопроса в той же variant_group (прежние гасим), под него
// - пустую заготовку ответа, и запускаем генерацию в фоне. Клиенту возвращается
// только id ответа: текст он получит, подписавшись на POST /api/chat/stream
// с assistant_message_id.

export const dynamic = 'force-dynamic';

/** Обязательное строковое поле. */
function requireStr(value: unknown, name: string): { value: string } | { response: NextResponse } {
  if (typeof value === 'string') return { value };
  return {
    response:
      value === undefined
        ? validationError(['body', name], 'missing', 'Field required', null)
        : validationError(['body', name], 'string_type', 'Input should be a valid string', value),
  };
}

/** Обязательный идентификатор (UUID) в теле запроса. */
function requireId(value: unknown, name: string): { value: string } | { response: NextResponse } {
  const id = asUuid(value);
  if (id) return { value: id };
  return {
    response:
      value === undefined
        ? validationError(['body', name], 'missing', 'Field required', null)
        : uuidError(['body', name], value),
  };
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return validationError(['body', 0], 'json_invalid', 'JSON decode error', {});
  }

  // Порядок проверок совпадает с порядком полей - в нём же возвращаются ошибки.
  const dialogueField = requireId(body.dialogue_id, 'dialogue_id');
  if ('response' in dialogueField) return dialogueField.response;
  const messageField = requireId(body.message_id, 'message_id');
  if ('response' in messageField) return messageField.response;
  const textField = requireStr(body.text, 'text');
  if ('response' in textField) return textField.response;

  const dialogue = await prisma.dialogues.findUnique({
    where: { id: dialogueField.value },
    select: { id: true, user_id: true, memory_summary: true },
  });
  if (!dialogue || dialogue.user_id !== user.id) return notFound('Диалог не найден');

  const orig = await prisma.chat_messages.findUnique({
    where: { id: messageField.value },
    select: {
      id: true,
      dialogue_id: true,
      role: true,
      variant_group: true,
      forwarded_meta: true,
      branch_of: true,
    },
  });
  if (!orig || orig.dialogue_id !== dialogue.id || orig.role !== 'user') {
    return notFound('Сообщение не найдено');
  }

  const text = textField.value.trim();
  if (!text) return badRequest('Пустой текст сообщения');

  // Бэкфилл для старых сообщений без метаданных вариантов: группу нужно
  // проставить до массового гашения - иначе исходный вопрос под него не попадёт.
  const group = orig.variant_group ?? orig.id;
  if (orig.variant_group === null) {
    await prisma.chat_messages.update({ where: { id: orig.id }, data: { variant_group: group } });
  }

  // Новый вариант вопроса активен, прежние - нет. Гасим только ветку вопросов,
  // ответы живут своими группами.
  await prisma.chat_messages.updateMany({
    where: { variant_group: group, role: 'user' },
    data: { variant_active: false },
  });

  const newUser = await prisma.chat_messages.create({
    data: {
      dialogue_id: dialogue.id,
      role: 'user',
      content: text,
      is_read: true,
      variant_group: group,
      // Пересланный блок и якорь ветки принадлежат вопросу - наследуются вариантом.
      forwarded_meta: orig.forwarded_meta
        ? (orig.forwarded_meta as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      branch_of: orig.branch_of,
    },
    select: { id: true },
  });

  const assistantMsg = await prisma.chat_messages.create({
    data: {
      dialogue_id: dialogue.id,
      role: 'assistant',
      is_finished: false,
      reply_to: newUser.id,
    },
    select: { id: true },
  });
  // Первый вариант ответа: группа = его собственный id.
  await prisma.chat_messages.update({
    where: { id: assistantMsg.id },
    data: { variant_group: assistantMsg.id },
  });

  await prisma.dialogues.update({
    where: { id: dialogue.id },
    data: { last_activity: new Date() },
  });

  // Контекст - сообщения до исходного вопроса: новый вариант логически стоит
  // на его месте, хотя id у него больше.
  const history = await collectHistoryBefore(dialogue.id, orig.id);
  // Вложения исходного вопроса переиспользуем как контекст.
  const attached = await prisma.chat_attachments.findMany({
    where: { message_id: orig.id },
    orderBy: { id: 'asc' },
    select: { id: true, filename: true, content: true, stored_path: true },
  });

  // При правке вопроса RAG всегда включён.
  const gen = genTextForUserMessage(text, orig.forwarded_meta, true);

  const state = new StreamState(dialogue.id, assistantMsg.id);
  registerStream(state);
  // Ответ уходит клиенту сразу, а генерация продолжается: after() не даёт Next
  // свернуть контекст запроса и убить её до подписки на стрим.
  after(async () => {
    await runGeneration({
      userText: gen.text,
      assistantMessageId: assistantMsg.id,
      dialogueId: dialogue.id,
      userId: dialogue.user_id,
      useRag: gen.useRag,
      history,
      attachedDocuments: attached,
      dialogueSummary: dialogue.memory_summary,
      state,
      forwarded: gen.forwarded,
      faqId: null,
    }).catch(() => undefined);
  });

  return NextResponse.json({ success: true, assistant_message_id: assistantMsg.id });
}
