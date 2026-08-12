import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { isoUtc, prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth';

// Список диалогов и создание нового.
// Порт GET/POST /api/dialogues из backend/routes/dialogues.py: формы ответов и
// коды статусов повторяют FastAPI 1-в-1 — фронтенд не должен замечать подмену.

const DEFAULT_TITLE = 'Новый диалог';
const PREVIEW_LIMIT = 140; // сколько символов превью последнего сообщения

/**
 * Показываем только «непустые» диалоги: есть хотя бы одно сообщение ИЛИ есть
 * черновик. Пустые (создан по «+», но ничего не введено) не сохраняются (#19).
 * Соответствует `nonempty` в Python: or_(has_message, draft IS NOT NULL AND draft != '').
 */
const NONEMPTY: Prisma.dialoguesWhereInput[] = [
  { chat_sessions: { some: { chat_messages: { some: {} } } } },
  { AND: [{ draft: { not: null } }, { draft: { not: '' } }] },
];

/** ISO-8601 в UTC: в базе лежит UTC, метка зоны обязательна. */
function isoNaive(d: Date): string {
  return d.toISOString();
}

/** Разбор числового query-параметра с зажатием в допустимый диапазон. */
function intParam(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** id сессии — 32 hex-символа, как uuid4().hex в backend/data/chat_sessions.py. */
function newSessionId(): string {
  return randomUUID().replace(/-/g, '');
}

// ── GET /api/dialogues ─────────────────────────────────────────────────────

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

  // Сессии всех диалогов страницы одним запросом. Порядок тот же, что в Python
  // (last_activity desc), поэтому первая сессия группы — «последняя по активности».
  const ids = rows.map((r) => r.id);
  const sessions = ids.length
    ? await prisma.chat_sessions.findMany({
        where: { dialogue_id: { in: ids } },
        orderBy: { last_activity: 'desc' },
        select: { id: true, dialogue_id: true },
      })
    : [];
  const sessionsByDialogue = new Map<number, string[]>();
  for (const s of sessions) {
    const list = sessionsByDialogue.get(s.dialogue_id);
    if (list) list.push(s.id);
    else sessionsByDialogue.set(s.dialogue_id, [s.id]);
  }

  const items = await Promise.all(
    rows.map(async (d) => {
      const sessionIds = sessionsByDialogue.get(d.id) ?? [];
      let lastMessage: { role: string; text: string; ts: string | null } | null = null;
      let unread = false;

      if (sessionIds.length) {
        const [lm, unreadRow] = await Promise.all([
          // Превью последнего сообщения (для карточки диалога)
          prisma.chat_messages.findFirst({
            where: { session_id: { in: sessionIds } },
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
            select: { role: true, content: true, created_at: true, finished_at: true },
          }),
          // Непрочитанные: завершённый ответ ассистента, который не прочитан
          prisma.chat_messages.findFirst({
            where: {
              session_id: { in: sessionIds },
              role: 'assistant',
              is_read: false,
              is_finished: true,
            },
            select: { id: true },
          }),
        ]);

        if (lm) {
          // str.replace в Python меняет ВСЕ переводы строк, поэтому replaceAll.
          let text = (lm.content ?? '').trim().replaceAll('\n', ' ');
          if (text.length > PREVIEW_LIMIT) {
            // Python режет по code points (text[:140]), а не по UTF-16 —
            // иначе на эмодзи можно разорвать суррогатную пару.
            const chars = Array.from(text);
            if (chars.length > PREVIEW_LIMIT) {
              text = `${chars.slice(0, PREVIEW_LIMIT).join('').replace(/\s+$/u, '')}…`;
            }
          }
          // Время сообщения для показа в превью (UTC → браузер локализует).
          const at = lm.role === 'assistant' ? lm.finished_at ?? lm.created_at : lm.created_at;
          lastMessage = { role: lm.role, text, ts: isoUtc(at) };
        }
        unread = unreadRow !== null;
      }

      return {
        id: d.id,
        title: d.title,
        description: d.description,
        is_finished: d.is_finished,
        created_at: isoNaive(d.created_at),
        last_activity: isoNaive(d.last_activity),
        session_id: sessionIds[0] ?? null,
        last_message: lastMessage,
        unread,
      };
    })
  );

  // Статистика — тоже только по непустым диалогам (как и список), но БЕЗ
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

// ── POST /api/dialogues ────────────────────────────────────────────────────

/**
 * Самый свежий активный диалог пользователя БЕЗ сообщений (пустой/черновик).
 * Нужен, чтобы «+» не плодил новые чаты, а переиспользовал пустой (#19).
 * Порт _find_empty_dialogue: те же 30 кандидатов и тот же порядок перебора,
 * только запросов три вместо N+1.
 */
async function findEmptyDialogue(userId: number) {
  const candidates = await prisma.dialogues.findMany({
    where: {
      user_id: userId,
      is_finished: false,
      // Диалог с ожидающей пересылкой из мессенджера «занят» — не переиспользуем.
      // JSON-поле: Prisma требует DbNull, чтобы получить именно `IS NULL`.
      pending_forward: { equals: Prisma.DbNull },
    },
    orderBy: { last_activity: 'desc' },
    take: 30,
    select: { id: true, title: true },
  });
  if (!candidates.length) return null;

  const ids = candidates.map((c) => c.id);
  const sessions = await prisma.chat_sessions.findMany({
    where: { dialogue_id: { in: ids } },
    orderBy: { last_activity: 'desc' },
    select: { id: true, dialogue_id: true },
  });
  // Диалоги, у которых хоть в одной сессии есть сообщение, — уже не пустые.
  const busy = new Set(
    (
      await prisma.chat_sessions.findMany({
        where: { dialogue_id: { in: ids }, chat_messages: { some: {} } },
        select: { dialogue_id: true },
      })
    ).map((s) => s.dialogue_id)
  );

  const sessionsByDialogue = new Map<number, string[]>();
  for (const s of sessions) {
    const list = sessionsByDialogue.get(s.dialogue_id);
    if (list) list.push(s.id);
    else sessionsByDialogue.set(s.dialogue_id, [s.id]);
  }

  for (const d of candidates) {
    if (busy.has(d.id)) continue;
    // sessionIds[0] — последняя сессия по last_activity; undefined, если сессий нет.
    return { dialogue: d, sessionId: sessionsByDialogue.get(d.id)?.[0] ?? null };
  }
  return null;
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
    /* пустое тело — как {} (фронтенд шлёт именно {}) */
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  // Быстрое создание по «+» (без явных title/description): переиспользуем уже
  // существующий пустой диалог, чтобы не плодить чаты. Черновик (текст в поле
  // ввода) хранится на клиенте по session_id — при возврате он подхватится (#19).
  if (!title && !description) {
    const found = await findEmptyDialogue(user.id);
    if (found) {
      const sessionId =
        found.sessionId ??
        (
          await prisma.chat_sessions.create({
            data: { id: newSessionId(), dialogue_id: found.dialogue.id },
            select: { id: true },
          })
        ).id;
      return NextResponse.json({
        success: true,
        dialogue_id: found.dialogue.id,
        session_id: sessionId,
        title: found.dialogue.title,
        reused: true,
      });
    }
  }

  // description кладём СЫРЫМ (как в Python: description=body.description),
  // а не обрезанным — обрезка выше нужна только для проверки «пустой запрос».
  const created = await prisma.$transaction(async (tx) => {
    const d = await tx.dialogues.create({
      data: {
        user_id: user.id,
        title: title || DEFAULT_TITLE,
        description: typeof body.description === 'string' ? body.description : null,
        is_finished: false,
        memory_covers_up_to: 0,
      },
      select: { id: true, title: true },
    });
    const s = await tx.chat_sessions.create({
      data: { id: newSessionId(), dialogue_id: d.id },
      select: { id: true },
    });
    return { d, s };
  });

  return NextResponse.json({
    success: true,
    dialogue_id: created.d.id,
    session_id: created.s.id,
    title: created.d.title,
  });
}
