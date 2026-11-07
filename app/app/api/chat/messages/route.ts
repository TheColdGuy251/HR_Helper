import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { boolQuery, pyBool } from '@/lib/kb';
import { hiddenMessageIds, MESSAGE_SELECT, messageItems, requireOwnDialogue } from '@/lib/chat';

// История сообщений диалога.

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const sp = request.nextUrl.searchParams;
  const own = await requireOwnDialogue(sp.get('dialogue_id'), user.id, ['query', 'dialogue_id']);
  if ('response' in own) return own.response;
  const dialogueId = own.id;
  const mark = boolQuery(sp.get('mark_as_read'), 'mark_as_read');
  if ('response' in mark) return mark.response;

  const [dialogue, msgs] = await Promise.all([
    prisma.dialogues.findUnique({ where: { id: dialogueId }, select: { pending_forward: true } }),
    prisma.chat_messages.findMany({
      where: { dialogue_id: dialogueId },
      orderBy: { id: 'asc' },
      select: MESSAGE_SELECT,
    }),
  ]);

  // Ветвление как в ChatGPT: показываем только активную ветку дерева диалога
  // (неактивные варианты и всё их продолжение скрыты).
  const hidden = hiddenMessageIds(msgs);

  // Группы вариантов считаем по всем сообщениям (в т.ч. скрытым): счётчик "i/n"
  // должен показывать все варианты, а не только видимый.
  const groups = new Map<string, string[]>();
  const groupKey = (m: (typeof msgs)[number]) => `${m.role}:${m.variant_group ?? m.id}`;
  for (const m of msgs) {
    const key = groupKey(m);
    const list = groups.get(key);
    if (list) list.push(m.id);
    else groups.set(key, [m.id]);
  }

  const visible = msgs.filter((m) => !hidden.has(m.id));
  const items = await messageItems(visible);
  visible.forEach((m, i) => {
    const grp = groups.get(groupKey(m)) as string[];
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
    // Прочитанными помечаем все ответы ассистента, включая скрытые ветки.
    await prisma.chat_messages.updateMany({
      where: { dialogue_id: dialogueId, role: 'assistant', is_read: false },
      data: { is_read: true },
    });
    // Событие unread_changed не публикуем: счётчик в шапке обновится на следующем опросе.
  }

  return NextResponse.json({
    success: true,
    messages: items,
    unread_count: unread,
    // Пересланные из мессенджера сообщения, ожидающие первой отправки.
    pending_forward: pyBool(dialogue?.pending_forward) ? dialogue?.pending_forward : null,
  });
}
