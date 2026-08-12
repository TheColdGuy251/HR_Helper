import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, requireUser } from '@/lib/auth';
import { publish } from '@/lib/events';
import { generateText } from '@/lib/ml/llm';

// Фоновая генерация названия диалога по первым сообщениям.
// Порт POST /api/dialogues/{dialogue_id}/auto-title из backend/routes/dialogues.py
// (auto_title_dialogue + _auto_title_worker).
//
// Ответ отдаётся МГНОВЕННО: обращение к локальной модели долгое, и держать на
// нём HTTP-запрос нельзя. Готовое имя прилетает событием `dialogue_title`, плюс
// подхватывается следующим GET /api/dialogues.

const DEFAULT_TITLE = 'Новый диалог';

// Промпт дословно из backend/services/llm/prompts.py (SYSTEM_PROMPT_DIALOGUE_TITLE).
const SYSTEM_PROMPT_DIALOGUE_TITLE =
  'Вы кратко называете диалог HR-специалиста с ассистентом. Верните только короткое ' +
  'название (до 5 слов, без кавычек, без точки в конце, без префиксов). Например: ' +
  '«Приём на работу лаборанта», «Расчёт компенсации за отпуск», «Увольнение по ' +
  'собственному». Никакого другого текста.';

/** FastAPI объявляет dialogue_id как int; всё, что не влезает в int4, — заведомо не найдено. */
function parseId(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** Аналог `str.strip('«»"\'')` — срезает эти символы с обоих концов. */
function stripQuotes(s: string): string {
  return s.replace(/^[«»"']+/, '').replace(/[«»"']+$/, '');
}

/** Фоновая задача: подбирает короткое имя диалога через LLM и сохраняет в БД. */
async function autoTitleWorker(dialogueId: number, userId: number): Promise<void> {
  try {
    const d = await prisma.dialogues.findUnique({
      where: { id: dialogueId },
      select: { id: true, user_id: true, title: true },
    });
    if (!d || d.user_id !== userId) return;
    const current = (d.title || '').trim();
    if (current && current !== DEFAULT_TITLE) return;

    const msgs = await prisma.chat_messages.findMany({
      where: { is_finished: true, chat_sessions: { dialogue_id: d.id } },
      orderBy: { id: 'asc' },
      take: 4,
      select: { role: true, content: true },
    });
    if (!msgs.length) return;

    const body = msgs
      .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content.slice(0, 600)}`)
      .join('\n')
      .slice(0, 2400);

    let raw: string;
    try {
      raw = await generateText({
        system: SYSTEM_PROMPT_DIALOGUE_TITLE,
        user: body,
        maxTokens: 24,
        temperature: 0.2,
      });
    } catch {
      return; // модель недоступна — название останется прежним
    }

    // Длину считаем по символам, а не по кодовым единицам UTF-16: в Python
    // len() для кириллицы даёт число символов.
    const title = stripQuotes((raw || '').trim()).replace(/\.+$/, '').trim();
    if (!title || [...title].length > 80) return;

    // Перепроверим — пользователь мог за это время задать своё название.
    const fresh = await prisma.dialogues.findUnique({
      where: { id: dialogueId },
      select: { title: true },
    });
    if (!fresh) return;
    const freshTitle = (fresh.title || '').trim();
    if (freshTitle !== '' && freshTitle !== DEFAULT_TITLE) return;

    // last_activity бампаем сами: в SQLAlchemy это делает onupdate=current_timestamp.
    await prisma.dialogues.update({
      where: { id: dialogueId },
      data: { title, last_activity: new Date() },
    });

    // Клиент обновит список и покажет тост, не дожидаясь перезагрузки.
    publish(userId, { type: 'dialogue_title', dialogue_id: dialogueId, title });
  } catch {
    // Python здесь только пишет warning: авто-название — необязательная функция.
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ dialogue_id: string }> }
) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const { dialogue_id } = await params;
  const id = parseId(dialogue_id);
  // Чужой диалог отдаём как 404, а не 403 — ровно как Python.
  if (id === null) return notFound('Диалог не найден');
  const d = await prisma.dialogues.findUnique({
    where: { id },
    select: { user_id: true, title: true },
  });
  if (!d || d.user_id !== user.id) return notFound('Диалог не найден');

  const current = (d.title || '').trim();
  if (current && current !== DEFAULT_TITLE) {
    return NextResponse.json({ success: true, title: current, scheduled: false, reason: 'already_set' });
  }

  // after() продлевает жизнь запроса до конца генерации — без него Next может
  // свернуть контекст сразу после ответа и убить фоновую задачу.
  after(async () => {
    await autoTitleWorker(id, user.id);
  });

  return NextResponse.json({ success: true, title: d.title, scheduled: true });
}

/**
 * Других методов на этом пути FastAPI не обслуживает (Starlette отдаёт 405), но
 * без экспорта Next вернул бы 405 в своей форме. Отдаём то же, что Starlette.
 */
export async function GET() {
  return NextResponse.json({ detail: 'Method Not Allowed' }, { status: 405 });
}
