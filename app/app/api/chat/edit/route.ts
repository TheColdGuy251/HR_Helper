import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireUser } from '@/lib/auth';
import { validationError } from '@/lib/news';
import { collectHistoryBefore, genTextForUserMessage, registerStream, StreamState } from '@/lib/chat';
import { runGeneration } from '@/lib/chat-generate';

// Правка вопроса пользователя → НОВАЯ ветка диалога.
// Порт POST /api/chat/edit из backend/routes/chat.py (edit_message).
//
// Создаём новый вариант ВОПРОСА в той же variant_group (прежние гасим), под него
// — пустую заготовку ответа, и запускаем генерацию в фоне. Клиенту возвращается
// только id ответа: текст он получит, подписавшись на POST /api/chat/stream
// с assistant_message_id.

export const dynamic = 'force-dynamic';

/** Обязательное строковое поле pydantic-модели. */
function requireStr(value: unknown, name: string): { value: string } | { response: NextResponse } {
  if (typeof value === 'string') return { value };
  return {
    response:
      value === undefined
        ? validationError(['body', name], 'missing', 'Field required', null)
        : validationError(['body', name], 'string_type', 'Input should be a valid string', value),
  };
}

/** Обязательное целое поле pydantic-модели (lax-режим: "12" тоже число). */
function requireInt(value: unknown, name: string): { value: number } | { response: NextResponse } {
  if (typeof value === 'number' && Number.isInteger(value)) return { value };
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) {
    return { value: Number.parseInt(value.trim(), 10) };
  }
  return {
    response:
      value === undefined
        ? validationError(['body', name], 'missing', 'Field required', null)
        : validationError(['body', name], 'int_type', 'Input should be a valid integer', value),
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

  // Порядок проверок — как поля в EditMessageRequest: pydantic сообщает о них
  // именно в этой последовательности.
  const sessionField = requireStr(body.session_id, 'session_id');
  if ('response' in sessionField) return sessionField.response;
  const messageField = requireInt(body.message_id, 'message_id');
  if ('response' in messageField) return messageField.response;
  const textField = requireStr(body.text, 'text');
  if ('response' in textField) return textField.response;

  const session = await prisma.chat_sessions.findUnique({
    where: { id: sessionField.value },
    select: {
      id: true,
      dialogues: { select: { id: true, user_id: true, memory_summary: true } },
    },
  });
  if (!session || session.dialogues.user_id !== user.id) return notFound('Сессия не найдена');
  const dialogue = session.dialogues;

  const orig = await prisma.chat_messages.findUnique({
    where: { id: messageField.value },
    select: {
      id: true,
      session_id: true,
      role: true,
      variant_group: true,
      forwarded_meta: true,
      branch_of: true,
    },
  });
  if (!orig || orig.session_id !== session.id || orig.role !== 'user') {
    return notFound('Сообщение не найдено');
  }

  const text = textField.value.trim();
  if (!text) return badRequest('Пустой текст сообщения');

  // Бэкфилл для старых сообщений без метаданных вариантов: группу нужно
  // проставить ДО массового гашения — иначе исходный вопрос под него не попадёт.
  const group = orig.variant_group ?? orig.id;
  if (orig.variant_group === null) {
    await prisma.chat_messages.update({ where: { id: orig.id }, data: { variant_group: group } });
  }

  // Новый вариант вопроса активен, прежние — нет. Фильтр по роли сохранён из
  // Python: гасим только ветку вопросов, ответы живут своими группами.
  await prisma.chat_messages.updateMany({
    where: { variant_group: group, role: 'user' },
    data: { variant_active: false },
  });

  const newUser = await prisma.chat_messages.create({
    data: {
      session_id: session.id,
      role: 'user',
      content: text,
      is_read: true,
      is_finished: true,
      is_cancelled: false,
      last_seq: 0,
      variant_group: group,
      variant_active: true,
      // Пересланный блок и якорь ветки принадлежат вопросу — наследуются вариантом.
      forwarded_meta: orig.forwarded_meta
        ? (orig.forwarded_meta as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      branch_of: orig.branch_of,
    },
    select: { id: true },
  });

  const assistantMsg = await prisma.chat_messages.create({
    data: {
      session_id: session.id,
      role: 'assistant',
      content: '',
      is_read: false,
      is_finished: false,
      is_cancelled: false,
      last_seq: 0,
      variant_active: true,
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

  // Контекст — сообщения до ИСХОДНОГО вопроса: новый вариант логически стоит
  // на его месте, хотя id у него больше.
  const history = await collectHistoryBefore(session.id, orig.id);
  // Вложения исходного вопроса переиспользуем как контекст.
  const attached = await prisma.session_documents.findMany({
    where: { message_id: orig.id },
    orderBy: { id: 'asc' },
    select: { id: true, filename: true, content: true, stored_path: true },
  });

  // use_rag в EditMessageRequest нет — Python всегда передаёт True.
  const gen = genTextForUserMessage(text, orig.forwarded_meta, true);

  const state = new StreamState(session.id, assistantMsg.id);
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
