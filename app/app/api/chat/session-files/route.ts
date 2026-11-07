import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { requireOwnDialogue } from '@/lib/chat';

// Файлы, ожидающие отправки в чат.

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const own = await requireOwnDialogue(
    request.nextUrl.searchParams.get('dialogue_id'),
    gate.user.id,
    ['query', 'dialogue_id']
  );
  if ('response' in own) return own.response;

  // Только "ожидающие" вложения (ещё не привязанные к сообщению) - это и есть
  // очередь на прикрепление к следующему сообщению.
  const items = await prisma.chat_attachments.findMany({
    where: { dialogue_id: own.id, message_id: null },
    orderBy: { id: 'asc' },
    select: { id: true, filename: true, size_bytes: true, content: true, created_at: true },
  });

  return NextResponse.json({
    success: true,
    items: items.map((d) => ({
      id: d.id,
      name: d.filename,
      size: d.size_bytes,
      // Длина извлечённого текста в кодовых точках - считается из самого текста,
      // отдельно не хранится.
      chars: [...d.content].length,
      created_at: isoUtc(d.created_at),
    })),
  });
}
