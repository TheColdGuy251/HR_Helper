import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { asDict, boolQuery, pyStr } from '@/lib/kb';
import { idQuery, notHiddenFor, serializeFile, threadWhere, type FileRow } from '@/lib/messenger';

// Все вложения диалога: медиа, документы и ссылки - для модалки "Вложения".
//
// Собеседник не проверяется: при некорректном peer_id выборка
// просто окажется пустой.

const LINK_RE = /https?:\/\/[^\s<>"']+/g;

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const me = gate.user.id;

  const query = request.nextUrl.searchParams;
  const peer = idQuery(query.get('peer_id'), 'peer_id');
  if ('response' in peer) return peer.response;
  const general = boolQuery(query.get('general'), 'general');
  if ('response' in general) return general.response;

  const msgs = await prisma.user_messages.findMany({
    where: { AND: [threadWhere(me, peer.value, general.value), notHiddenFor(me)] },
    orderBy: { id: 'desc' },
  });

  const ids = msgs.map((m) => m.id);
  const files: FileRow[] = ids.length
    ? await prisma.user_message_files.findMany({
        where: { message_id: { in: ids } },
        orderBy: { id: 'desc' },
      })
    : [];

  const links: { url: string; message_id: string }[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    let text = m.content || '';
    const fm = asDict(m.forwarded_meta);
    if (fm.content) text += ' ' + pyStr(fm.content);
    for (const match of text.matchAll(LINK_RE)) {
      const url = match[0].replace(/[.,);]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ url, message_id: m.id });
    }
  }

  return NextResponse.json({
    media: files.filter((f) => f.is_image).map(serializeFile),
    documents: files.filter((f) => !f.is_image).map(serializeFile),
    links,
  });
}
