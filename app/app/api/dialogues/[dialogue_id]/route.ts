import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { asUuid } from '@/lib/ids';

// Правка и удаление диалога.
// POST /api/dialogues/{id}/auto-title живёт в подкаталоге auto-title.

const DEFAULT_TITLE = 'Новый диалог';

/** Диалог текущего пользователя. Чужой или несуществующий id = 404 (не 403). */
async function ownedDialogue(rawId: string, userId: string) {
  const id = asUuid(rawId);
  if (id === null) return null;
  const d = await prisma.dialogues.findUnique({
    where: { id },
    select: { id: true, user_id: true, title: true },
  });
  return d && d.user_id === userId ? d : null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ dialogue_id: string }> }
) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const { dialogue_id } = await params;
  const d = await ownedDialogue(dialogue_id, user.id);
  if (!d) return notFound('Диалог не найден');

  let body: { title?: unknown; description?: unknown; draft?: unknown } = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch {
    /* нет тела - менять нечего */
  }

  // Поле обновляем, только если оно есть в теле:
  // null/отсутствие означает "не трогать", а пустая строка - "очистить".
  const data: Prisma.dialoguesUncheckedUpdateInput = {};
  if (typeof body.title === 'string') {
    data.title = body.title.trim() || DEFAULT_TITLE;
  }
  if (typeof body.description === 'string') {
    data.description = body.description || null;
  }
  if (typeof body.draft === 'string') {
    data.draft = body.draft || null; // пустая строка -> NULL (диалог снова "пустой")
  }

  if (!Object.keys(data).length) {
    // Нечего менять - UPDATE не делаем, last_activity не трогаем.
    return NextResponse.json({ success: true, title: d.title });
  }

  // last_activity обновляем при каждом изменении.
  // Иначе диалог, в котором прямо сейчас печатают (автосохранение draft),
  // уезжал бы вниз списка - он сортируется по last_activity.
  data.last_activity = new Date();

  const updated = await prisma.dialogues.update({
    where: { id: d.id },
    data,
    select: { title: true },
  });
  return NextResponse.json({ success: true, title: updated.title });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ dialogue_id: string }> }
) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const { dialogue_id } = await params;
  const d = await ownedDialogue(dialogue_id, user.id);
  if (!d) return notFound('Диалог не найден');

  // Сообщения и вложения удалятся каскадом по внешним ключам (ON DELETE CASCADE
  // объявлен в самой БД).
  await prisma.dialogues.delete({ where: { id: d.id } });
  return NextResponse.json({ success: true });
}
