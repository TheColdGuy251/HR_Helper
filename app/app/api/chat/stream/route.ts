import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound, requireUser } from '@/lib/auth';
import { validationError } from '@/lib/news';
import { pyBool } from '@/lib/kb';
import {
  collectHistoryBefore,
  genTextForUserMessage,
  getStream,
  hiddenMessageIds,
  registerStream,
  StreamState,
  unregisterStream,
} from '@/lib/chat';
import { runGeneration } from '@/lib/chat-generate';

// Главный эндпоинт чата: SSE-поток ответа ассистента.
// Порт POST /api/chat/stream (backend/routes/chat.py: stream + _run_generation).
// Кадры, заголовки и коды статусов совпадают с FastAPI 1-в-1.

export const dynamic = 'force-dynamic';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  'X-Accel-Buffering': 'no',
};

// ---------------------------------------------------------------------------
// Вспомогательное
// ---------------------------------------------------------------------------

function frame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Имя файла из пути (бэкенд пишет Windows-пути, поэтому оба разделителя). */
function baseName(p: string | null): string | null {
  if (!p) return null;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

async function attachmentInfo(documentId: number | null) {
  if (!documentId) return null;
  const doc = await prisma.my_documents.findUnique({
    where: { id: documentId },
    select: { id: true, title: true, file_path: true, template_key: true },
  });
  if (!doc) return null;
  return {
    id: doc.id,
    title: doc.title,
    filename: baseName(doc.file_path),
    template_key: doc.template_key,
  };
}

// ---------------------------------------------------------------------------
// SSE-ответ
// ---------------------------------------------------------------------------

/** Порт `_build_done_payload`: финальный кадр берёт текст ПОСЛЕ пост-обработки. */
async function buildDonePayload(messageId: number, lastSeq: number) {
  const payload: Record<string, unknown> = { done: true, message_id: messageId, last_seq: lastSeq };
  try {
    const msg = await prisma.chat_messages.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        role: true,
        session_id: true,
        content: true,
        sources: true,
        meta: true,
        attachment_document_id: true,
        variant_group: true,
      },
    });
    if (!msg) return payload;
    if (msg.content) payload.content = msg.content;
    if (pyBool(msg.sources)) payload.sources = msg.sources;
    if (pyBool(msg.meta)) payload.meta = msg.meta;
    const att = await attachmentInfo(msg.attachment_document_id);
    if (att) payload.attachment = att;

    // Инфо о вариантах ответа (‹ i/n ›) — актуально после ретрая.
    if (msg.role === 'assistant') {
      const group = msg.variant_group ?? msg.id;
      const variants = await prisma.chat_messages.findMany({
        where: { session_id: msg.session_id, variant_group: group, role: 'assistant' },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      if (variants.length > 1) {
        const idx = variants.findIndex((v) => v.id === msg.id);
        payload.variant_group = group;
        payload.variant_index = (idx < 0 ? variants.length - 1 : idx) + 1;
        payload.variant_count = variants.length;
      }
    }
  } catch {
    /* вложение/варианты не сложились — отдаём базовый кадр */
  }
  return payload;
}

const KEEPALIVE = new TextEncoder().encode('data: {"noop": true}\n\n');

function sseResponse(state: StreamState, initialSeq: number, isSubscribe: boolean): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // Готовый Uint8Array отправляем как есть (keepalive), остальное сериализуем.
      const send = (payload: unknown) => {
        if (closed) return false;
        try {
          controller.enqueue(payload instanceof Uint8Array ? payload : frame(payload));
          return true;
        } catch {
          closed = true; // клиент отключился — генерация продолжается в фоне
          return false;
        }
      };

      // Сначала initial snapshot — для возобновлений и поздних подписчиков.
      const head: Record<string, unknown> = {
        initial: true,
        initial_chunk: state.buffer.slice(initialSeq).join(''),
        message_id: state.message_id,
        last_seq: state.last_seq,
        status: state.status,
      };
      if (state.status === 'queued') {
        head.queue_position = state.queue_position;
        head.queue_total = state.queue_total;
      }
      if (state.user_message_id) head.user_message_id = state.user_message_id;
      if (state.sources.length) head.sources = state.sources;
      send(head);

      let lastStatus = state.status;
      let lastQpos = state.queue_position;
      let lastYielded = state.last_seq;
      let sourcesSent = state.sources.length > 0;

      for (;;) {
        if (closed) break;

        if (state.finished && lastYielded >= state.last_seq) {
          send(await buildDonePayload(state.message_id, state.last_seq));
          if (!isSubscribe) unregisterStream(state);
          break;
        }

        // Ждём новых событий (или таймаута для keepalive).
        const signaled = await state.event.wait(10_000);
        if (!signaled) {
          // Heartbeat в виде data-события с маркером noop — клиент его явно
          // отфильтровывает и не подмешивает в текст.
          if (!send(KEEPALIVE)) break;
          continue;
        }
        state.event.clear();

        // Публикуем источники, как только они готовы (до текста).
        if (!sourcesSent && state.sources.length) {
          sourcesSent = true;
          send({ sources: state.sources, message_id: state.message_id });
        }

        // Обновление статуса (очередь / поиск / реранкинг / генерация).
        if (
          state.status !== lastStatus ||
          (state.status === 'queued' && state.queue_position !== lastQpos)
        ) {
          lastStatus = state.status;
          lastQpos = state.queue_position;
          const st: Record<string, unknown> = { status: state.status, message_id: state.message_id };
          if (state.status === 'queued') {
            st.queue_position = state.queue_position;
            st.queue_total = state.queue_total;
          }
          send(st);
        }

        // Шлём накопившиеся чанки.
        while (lastYielded < state.last_seq) {
          const chunk = state.buffer[lastYielded];
          lastYielded += 1;
          send({ seq: lastYielded, chunk, message_id: state.message_id });
        }

        if (state.finished && lastYielded >= state.last_seq) {
          send(await buildDonePayload(state.message_id, state.last_seq));
          if (!isSubscribe) unregisterStream(state);
          break;
        }
      }

      try {
        controller.close();
      } catch {
        /* поток уже закрыт клиентом */
      }
    },
  });

  return new Response(body, { headers: SSE_HEADERS });
}

// ---------------------------------------------------------------------------
// POST /api/chat/stream
// ---------------------------------------------------------------------------

interface StreamBody {
  session_id?: unknown;
  message?: unknown;
  assistant_message_id?: unknown;
  retry_of?: unknown;
  last_seq?: unknown;
  use_rag?: unknown;
  faq_id?: unknown;
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

const SESSION_SELECT = {
  id: true,
  dialogues: {
    select: {
      id: true,
      user_id: true,
      memory_summary: true,
      pending_forward: true,
    },
  },
} as const;

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const raw = await request.text();
  let body: StreamBody;
  try {
    body = raw ? (JSON.parse(raw) as StreamBody) : {};
  } catch {
    return validationError(['body', 0], 'json_invalid', 'JSON decode error', {});
  }
  if (typeof body.session_id !== 'string') {
    return validationError(['body', 'session_id'], 'missing', 'Field required', null);
  }

  const sessionId = body.session_id;
  const assistantMessageId = intOrNull(body.assistant_message_id);
  const retryOf = intOrNull(body.retry_of);
  const faqId = intOrNull(body.faq_id);
  const lastSeq = intOrNull(body.last_seq) ?? 0;
  const useRag = body.use_rag === undefined ? true : Boolean(body.use_rag);

  const session = await prisma.chat_sessions.findUnique({
    where: { id: sessionId },
    select: SESSION_SELECT,
  });
  if (!session || session.dialogues.user_id !== user.id) return notFound('Сессия не найдена');

  const dialogue = session.dialogues;
  let state: StreamState;

  // ─── Подписка на уже идущий стрим ──────────────────────────────────────
  if (assistantMessageId) {
    const existing = getStream(assistantMessageId);
    if (existing) {
      return sseResponse(existing, lastSeq, true);
    }

    const msg = await prisma.chat_messages.findUnique({
      where: { id: assistantMessageId },
      select: {
        id: true,
        session_id: true,
        content: true,
        last_seq: true,
        attachment_document_id: true,
      },
    });
    if (!msg || msg.session_id !== session.id) return notFound('Сообщение не найдено');

    // Стрим завершён и убран из реестра — отдаём сохранённый ответ из БД.
    // Если сообщение при этом не завершено, генерация была осиротена
    // перезапуском процесса: реестр живёт в памяти и рестарт его теряет.
    // Python в такой ситуации поступает так же — отдаёт кадр done с тем, что
    // успело сохраниться, и пузырь перестаёт «висеть» на клиенте.
    const att = await attachmentInfo(msg.attachment_document_id);
    const done: Record<string, unknown> = {
      done: true,
      message_id: msg.id,
      last_seq: msg.last_seq || 0,
    };
    if (att) done.attachment = att;

    const replay = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          frame({
            initial: true,
            initial_chunk: msg.content || '',
            message_id: msg.id,
            last_seq: msg.last_seq || 0,
          })
        );
        controller.enqueue(frame(done));
        controller.close();
      },
    });
    return new Response(replay, { headers: SSE_HEADERS });
  }

  // ─── «Попробовать снова»: новый вариант ответа на тот же вопрос ─────────
  if (retryOf) {
    const retried = await prisma.chat_messages.findUnique({
      where: { id: retryOf },
      select: { id: true, session_id: true, role: true, variant_group: true, reply_to: true },
    });
    if (!retried || retried.session_id !== session.id || retried.role !== 'assistant') {
      return notFound('Ответ для повтора не найден');
    }

    // Бэкфилл для старых сообщений без метаданных вариантов.
    const group = retried.variant_group ?? retried.id;
    if (retried.variant_group === null) {
      await prisma.chat_messages.update({
        where: { id: retried.id },
        data: { variant_group: group },
      });
    }

    // reply_to может быть пуст у старых сообщений — берём ближайший предыдущий вопрос.
    let replyToId = retried.reply_to;
    if (!replyToId) {
      const prevUser = await prisma.chat_messages.findFirst({
        where: { session_id: session.id, role: 'user', id: { lt: retried.id } },
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      replyToId = prevUser?.id ?? null;
      if (replyToId) {
        await prisma.chat_messages.update({
          where: { id: retried.id },
          data: { reply_to: replyToId },
        });
      }
    }
    if (!replyToId) return badRequest('Не найден исходный вопрос для повтора');

    const userQ = await prisma.chat_messages.findUnique({
      where: { id: replyToId },
      select: { id: true, content: true, forwarded_meta: true },
    });
    if (!userQ) return badRequest('Исходный вопрос недоступен');

    // Новый вариант становится активным, прежние — неактивны.
    await prisma.chat_messages.updateMany({
      where: { variant_group: group },
      data: { variant_active: false },
    });

    const newMsg = await prisma.chat_messages.create({
      data: {
        session_id: session.id,
        role: 'assistant',
        content: '',
        is_read: false,
        is_finished: false,
        is_cancelled: false,
        last_seq: 0,
        variant_group: group,
        variant_active: true,
        reply_to: replyToId,
      },
      select: { id: true },
    });

    await prisma.dialogues.update({
      where: { id: dialogue.id },
      data: { last_activity: new Date() },
    });

    const history = await collectHistoryBefore(session.id, replyToId);
    // Вложения исходного вопроса переиспользуем как контекст.
    const attached = await prisma.session_documents.findMany({
      where: { message_id: replyToId },
      orderBy: { id: 'asc' },
      select: { id: true, filename: true, content: true, stored_path: true },
    });

    const gen = genTextForUserMessage(
      (userQ.content || '').trim(),
      userQ.forwarded_meta,
      useRag
    );

    state = new StreamState(session.id, newMsg.id);
    registerStream(state);
    // Генерация живёт дольше HTTP-запроса (клиент может отвалиться и подписаться
  // заново) — поэтому промис намеренно «висячий», но с перехватом отказа.
  runGeneration({
      userText: gen.text,
      assistantMessageId: newMsg.id,
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

    return sseResponse(state, lastSeq, false);
  }

  // ─── Обычная отправка сообщения ────────────────────────────────────────
  // Пересланные из мессенджера сообщения уходят с ПЕРВОЙ отправкой: текст
  // пользователя при этом может быть пустым.
  const pendingFwd = pyBool(dialogue.pending_forward) ? dialogue.pending_forward : null;
  const msgText = typeof body.message === 'string' ? body.message.trim() : '';
  if (!msgText && !pendingFwd) return badRequest('Не передано сообщение');

  // Якорь ветки: последний ВИДИМЫЙ ответ ассистента. Если пользователь
  // переключился на старую ветку и продолжил, вопрос прицепится к ней.
  const allMsgs = await prisma.chat_messages.findMany({
    where: { session_id: session.id },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      role: true,
      variant_group: true,
      variant_active: true,
      reply_to: true,
      branch_of: true,
    },
  });
  const hidden = hiddenMessageIds(allMsgs);
  let branchAnchor: number | null = null;
  for (let i = allMsgs.length - 1; i >= 0; i--) {
    const m = allMsgs[i];
    if (m.role === 'assistant' && !hidden.has(m.id)) {
      branchAnchor = m.id;
      break;
    }
  }

  // 1) Сообщение пользователя и 2) заготовка ответа ассистента.
  const created = await prisma.$transaction(async (tx) => {
    const userMsg = await tx.chat_messages.create({
      data: {
        session_id: session.id,
        role: 'user',
        content: msgText,
        is_read: true,
        is_finished: true,
        is_cancelled: false,
        last_seq: 0,
        variant_active: true,
        forwarded_meta: pendingFwd ? (pendingFwd as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        branch_of: branchAnchor,
      },
      select: { id: true },
    });
    // Пользовательское сообщение — первый вариант своей группы (для «изменить»).
    await tx.chat_messages.update({
      where: { id: userMsg.id },
      data: { variant_group: userMsg.id },
    });
    if (pendingFwd) {
      await tx.dialogues.update({
        where: { id: dialogue.id },
        data: { pending_forward: Prisma.DbNull },
      });
    }

    const assistantMsg = await tx.chat_messages.create({
      data: {
        session_id: session.id,
        role: 'assistant',
        content: '',
        is_read: false,
        is_finished: false,
        is_cancelled: false,
        last_seq: 0,
        variant_active: true,
        reply_to: userMsg.id,
      },
      select: { id: true },
    });
    // Первый вариант ответа: группа = его собственный id.
    await tx.chat_messages.update({
      where: { id: assistantMsg.id },
      data: { variant_group: assistantMsg.id },
    });

    // 3) Обновляем активность диалога.
    await tx.dialogues.update({ where: { id: dialogue.id }, data: { last_activity: new Date() } });
    return { userId: userMsg.id, assistantId: assistantMsg.id };
  });

  // История — ДО текущего вопроса: сам он уходит в промпт отдельно.
  const history = await collectHistoryBefore(session.id, created.userId);

  // Вложения, ОЖИДАЮЩИЕ отправки (message_id IS NULL) — привязываем их к
  // текущему сообщению пользователя и кладём в контекст.
  const pendingDocs = await prisma.session_documents.findMany({
    where: { session_id: session.id, message_id: null },
    orderBy: { id: 'asc' },
    select: { id: true, filename: true, content: true, stored_path: true },
  });
  if (pendingDocs.length) {
    await prisma.session_documents.updateMany({
      where: { id: { in: pendingDocs.map((d) => d.id) } },
      data: { message_id: created.userId },
    });
  }

  const gen = genTextForUserMessage(msgText, pendingFwd, useRag);

  state = new StreamState(session.id, created.assistantId, created.userId);
  registerStream(state);
  // Генерация живёт дольше HTTP-запроса (клиент может отвалиться и подписаться
  // заново) — поэтому промис намеренно «висячий», но с перехватом отказа.
  runGeneration({
    userText: gen.text,
    assistantMessageId: created.assistantId,
    dialogueId: dialogue.id,
    userId: dialogue.user_id,
    useRag: gen.useRag,
    history,
    attachedDocuments: pendingDocs,
    dialogueSummary: dialogue.memory_summary,
    state,
    forwarded: gen.forwarded,
    faqId,
  }).catch(() => undefined);

  return sseResponse(state, lastSeq, false);
}

/**
 * GET на этот путь FastAPI не обслуживает (405 Method Not Allowed), но без
 * экспорта Next вернул бы 405 сам — форма ответа при этом отличалась бы.
 * Отдаём то же, что Starlette.
 */
export async function GET() {
  return NextResponse.json({ detail: 'Method Not Allowed' }, { status: 405 });
}
