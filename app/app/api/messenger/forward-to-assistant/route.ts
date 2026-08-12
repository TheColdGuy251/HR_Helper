import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { badRequest, initials, requireUser, shortName } from '@/lib/auth';
import type { CurrentUser } from '@/lib/auth';

// Пересылка выбранных сообщений в НОВЫЙ диалог с ассистентом.
// Порт POST /api/messenger/forward-to-assistant из backend/routes/messenger.py.
//
// Снимок сообщений кладётся в dialogue.pending_forward: страница чата покажет
// его как пересланный блок, а при первой отправке он попадёт в контекст модели.

const DEFAULT_TITLE = 'Новый диалог';

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  let body: { message_ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest('Не выбраны сообщения');
  }

  // Тело приходит с Body(..., embed=True), то есть завёрнутым в имя параметра.
  const raw = Array.isArray(body.message_ids) ? body.message_ids : [];
  const ids = raw
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v)
    .slice(0, 30);
  if (!ids.length) return badRequest('Не выбраны сообщения');

  const msgs = await prisma.user_messages.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
  });

  // Имена отправителей и собеседников — одним запросом вместо обхода по одному.
  const peopleIds = new Set<number>();
  for (const m of msgs) {
    if (m.sender_id) peopleIds.add(m.sender_id);
    if (m.recipient_id) peopleIds.add(m.recipient_id);
  }
  const people = peopleIds.size
    ? await prisma.users.findMany({ where: { id: { in: [...peopleIds] } } })
    : [];
  const byId = new Map(people.map((p) => [p.id, p as CurrentUser]));

  const files = await prisma.user_message_files.findMany({
    where: { message_id: { in: ids } },
    orderBy: { id: 'asc' },
  });
  const filesByMsg = new Map<number, typeof files>();
  for (const f of files) {
    if (f.message_id == null) continue; // вложение без привязки — пропускаем
    const list = filesByMsg.get(f.message_id) || [];
    list.push(f);
    filesByMsg.set(f.message_id, list);
  }

  const items: Record<string, unknown>[] = [];
  for (const m of msgs) {
    // Только сообщения из бесед, где пересылающий — участник.
    if (!m.is_general && user.id !== m.sender_id && user.id !== m.recipient_id) continue;
    const fm = (m.forwarded_meta || {}) as Record<string, unknown>;
    if (fm.system) continue; // служебные строки («закреплено» и т.п.) не пересылаем

    const sender = m.sender_id ? byId.get(m.sender_id) : undefined;
    let chatLabel: string;
    if (m.is_general) {
      chatLabel = 'Общий чат';
    } else {
      const peerId = m.sender_id === user.id ? m.recipient_id : m.sender_id;
      const peer = peerId ? byId.get(peerId) : undefined;
      chatLabel = peer ? `личный чат с ${shortName(peer)}` : 'личный чат';
    }

    items.push({
      from_name: fm.ai ? 'HR-ассистент' : sender ? shortName(sender) : '—',
      from_initials: sender ? initials(sender) : '?',
      chat: chatLabel,
      // Время с явной меткой UTC — как в Python (.replace(tzinfo=utc).isoformat()).
      sent_at: (m.created_at ?? new Date()).toISOString().replace('Z', '+00:00'),
      text: (fm.content as string) || m.content || '',
      ai: Boolean(fm.ai),
      attachments: (filesByMsg.get(m.id) || []).map((f) => ({
        id: f.id,
        name: f.original_name,
        is_image: f.is_image,
        url: `/api/messenger/files/${f.id}`,
        w: f.img_w,
        h: f.img_h,
      })),
    });
  }

  if (!items.length) return badRequest('Нет доступных для пересылки сообщений');

  // Заголовок оставляем дефолтным, чтобы после первого ответа сработало
  // авто-название диалога.
  const dialogue = await prisma.dialogues.create({
    data: {
      user_id: user.id,
      title: DEFAULT_TITLE,
      is_finished: false,
      memory_covers_up_to: 0,
      // Prisma требует явного приведения: снимок хранится JSON-массивом.
      pending_forward: items as unknown as import('@prisma/client').Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const session = await prisma.chat_sessions.create({
    data: { id: randomUUID().replace(/-/g, ''), dialogue_id: dialogue.id },
    select: { id: true },
  });

  return NextResponse.json({
    success: true,
    dialogue_id: dialogue.id,
    session_id: session.id,
  });
}
