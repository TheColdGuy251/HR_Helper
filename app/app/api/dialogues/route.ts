import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { isoUtc, prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';

// Список диалогов и создание нового.

const DEFAULT_TITLE = 'Новый диалог';
const PREVIEW_LIMIT = 140; // сколько символов превью последнего сообщения

/**
 * Показываем только "непустые" диалоги: есть хотя бы одно сообщение или есть
 * черновик. Пустые (создан по "+", но ничего не введено) не сохраняются.
 */
const NONEMPTY: Prisma.dialoguesWhereInput[] = [
  { messages: { some: {} } },
  { AND: [{ draft: { not: null } }, { draft: { not: '' } }] },
];

/** Разбор числового query-параметра с зажатием в допустимый диапазон. */
function intParam(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// GET /api/dialogues

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const sp = request.nextUrl.searchParams;
  const filter = sp.get('filter') ?? 'active';
  const pageSize = intParam(sp.get('page_size'), 20, 1, 100);
  let page = intParam(sp.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const search = sp.get('search');

  // База для статистики (без filter/search) и для выборки страницы.
  const base: Prisma.dialoguesWhereInput = { user_id: user.id, OR: NONEMPTY };
  const where: Prisma.dialoguesWhereInput = { ...base };
  if (filter === 'active') where.is_finished = false;
  else if (filter === 'finished') where.is_finished = true;
  const query = search?.trim();
  if (query) where.title = { contains: query, mode: 'insensitive' };

  const total = await prisma.dialogues.count({ where });
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  // Клампим страницу в допустимый диапазон, чтобы не отдавать пустоту
  if (totalPages && page > totalPages) page = totalPages;
  const offset = (page - 1) * pageSize;

  const rows = await prisma.dialogues.findMany({
    where,
    orderBy: { last_activity: 'desc' },
    skip: offset,
    take: pageSize,
  });

  const items = await Promise.all(
    rows.map(async (d) => {
      const [lm, unreadRow] = await Promise.all([
        // Превью последнего сообщения (для карточки диалога)
        prisma.chat_messages.findFirst({
          where: { dialogue_id: d.id },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          select: { role: true, content: true, created_at: true, finished_at: true },
        }),
        // Непрочитанные: завершённый ответ ассистента, который не прочитан
        prisma.chat_messages.findFirst({
          where: { dialogue_id: d.id, role: 'assistant', is_read: false, is_finished: true },
          select: { id: true },
        }),
      ]);

      let lastMessage: { role: string; text: string; ts: string | null } | null = null;
      if (lm) {
        // Меняем все переводы строк.
        let text = (lm.content ?? '').trim().replaceAll('\n', ' ');
        if (text.length > PREVIEW_LIMIT) {
          // Режем по кодовым точкам, а не по UTF-16 - иначе на эмодзи можно
          // разорвать суррогатную пару.
          const chars = Array.from(text);
          if (chars.length > PREVIEW_LIMIT) {
            text = `${chars.slice(0, PREVIEW_LIMIT).join('').replace(/\s+$/u, '')}…`;
          }
        }
        // Время сообщения для показа в превью (UTC -> браузер локализует).
        const at = lm.role === 'assistant' ? lm.finished_at ?? lm.created_at : lm.created_at;
        lastMessage = { role: lm.role, text, ts: isoUtc(at) };
      }

      return {
        id: d.id,
        title: d.title,
        description: d.description,
        is_finished: d.is_finished,
        created_at: isoUtc(d.created_at),
        last_activity: isoUtc(d.last_activity),
        last_message: lastMessage,
        unread: unreadRow !== null,
      };
    })
  );

  // Статистика - тоже только по непустым диалогам (как и список), но без
  // учёта filter/search: вкладки показывают полные счётчики.
  const [statTotal, statActive, statFinished] = await Promise.all([
    prisma.dialogues.count({ where: base }),
    prisma.dialogues.count({ where: { ...base, is_finished: false } }),
    prisma.dialogues.count({ where: { ...base, is_finished: true } }),
  ]);

  return NextResponse.json({
    success: true,
    items,
    stats: { total: statTotal, active: statActive, finished: statFinished },
    page,
    page_size: pageSize,
    total,
    total_pages: totalPages,
  });
}

// POST /api/dialogues

/**
 * Самый свежий активный диалог пользователя без сообщений (пустой/черновик).
 * Нужен, чтобы "+" не плодил новые чаты, а переиспользовал пустой.
 */
function findEmptyDialogue(userId: string) {
  return prisma.dialogues.findFirst({
    where: {
      user_id: userId,
      is_finished: false,
      messages: { none: {} },
      // Диалог с ожидающей пересылкой из мессенджера "занят" - не переиспользуем.
      // JSON-поле: Prisma требует DbNull, чтобы получить именно `IS NULL`.
      pending_forward: { equals: Prisma.DbNull },
    },
    orderBy: { last_activity: 'desc' },
    select: { id: true, title: true },
  });
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  let body: { title?: unknown; description?: unknown } = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch {
    /* пустое тело - как {} (фронтенд шлёт именно {}) */
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  // Быстрое создание по "+" (без явных title/description): переиспользуем уже
  // существующий пустой диалог, чтобы не плодить чаты. Черновик (текст в поле
  // ввода) хранится на клиенте по id диалога - при возврате он подхватится.
  if (!title && !description) {
    const found = await findEmptyDialogue(user.id);
    if (found) {
      return NextResponse.json({
        success: true,
        dialogue_id: found.id,
        title: found.title,
        reused: true,
      });
    }
  }

  // description кладём сырым,
  // а не обрезанным - обрезка выше нужна только для проверки "пустой запрос".
  const created = await prisma.dialogues.create({
    data: {
      user_id: user.id,
      title: title || DEFAULT_TITLE,
      description: typeof body.description === 'string' ? body.description : null,
    },
    select: { id: true, title: true },
  });

  return NextResponse.json({ success: true, dialogue_id: created.id, title: created.title });
}
