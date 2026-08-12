import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { boolQuery, pyBool } from '@/lib/kb';
import { validationError } from '@/lib/news';
import { hiddenMessageIds, MESSAGE_SELECT, messageItems } from '@/lib/chat';

// История сообщений сессии. Порт GET /api/chat/messages (backend/routes/chat.py:
// list_messages) — форма ответа и коды статусов повторяют FastAPI 1-в-1.

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const sp = request.nextUrl.searchParams;
  const sessionId = sp.get('session_id');
  if (sessionId === null) {
    return validationError(['query', 'session_id'], 'missing', 'Field required', null);
  }
  const mark = boolQuery(sp.get('mark_as_read'), 'mark_as_read');
  if ('response' in mark) return mark.response;

  const session = await prisma.chat_sessions.findUnique({
    where: { id: sessionId },
    select: { id: true, dialogues: { select: { user_id: true, pending_forward: true } } },
  });
  if (!session || session.dialogues.user_id !== user.id) return notFound('Сессия не найдена');

  const msgs = await prisma.chat_messages.findMany({
    where: { session_id: sessionId },
    orderBy: { id: 'asc' },
    select: MESSAGE_SELECT,
  });

  // Ветвление как в ChatGPT: показываем только активную ветку дерева диалога
  // (неактивные варианты и всё их продолжение скрыты).
  const hidden = hiddenMessageIds(msgs);

  // Группы вариантов считаем по ВСЕМ сообщениям (в т.ч. скрытым): счётчик «i/n»
  // должен показывать все варианты, а не только видимый.
  const groups = new Map<string, number[]>();
  const groupKey = (m: (typeof msgs)[number]) => `${m.role}:${m.variant_group ?? m.id}`;
  for (const m of msgs) {
    const key = groupKey(m);
    const list = groups.get(key);
    if (list) list.push(m.id);
    else groups.set(key, [m.id]);
  }

  const visible = msgs.filter((m) => !hidden.has(m.id));
  const items = await messageItems(visible, user);
  visible.forEach((m, i) => {
    const grp = groups.get(groupKey(m)) as number[];
    if (grp.length > 1) {
      items[i].variant_group = m.variant_group ?? m.id;
      items[i].variant_index = grp.indexOf(m.id) + 1;
      items[i].variant_count = grp.length;
    }
  });

  const unread = msgs.filter(
    (m) => m.role === 'assistant' && !m.is_read && !hidden.has(m.id)
  ).length;

  if (mark.value && unread) {
    // Python помечает прочитанными ВСЕ ответы ассистента, включая скрытые ветки.
    await prisma.chat_messages.updateMany({
      where: { session_id: sessionId, role: 'assistant', is_read: false },
      data: { is_read: true },
    });
    // Python здесь ещё публикует событие unread_changed в SSE-шину уведомлений.
    // Шина живёт в процессе FastAPI и из Next недостижима — счётчик в шапке
    // обновится на следующем опросе, а не мгновенно.
  }

  return NextResponse.json({
    success: true,
    messages: items,
    unread_count: unread,
    // Пересланные из мессенджера сообщения, ожидающие первой отправки.
    pending_forward: pyBool(session.dialogues.pending_forward)
      ? session.dialogues.pending_forward
      : null,
  });
}
