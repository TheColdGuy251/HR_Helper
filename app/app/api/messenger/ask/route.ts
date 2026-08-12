import { NextResponse, after } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import type { poll_options, poll_votes } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, fullName, notFound, requireUser } from '@/lib/auth';
import { asDict, pyBool, pyStr } from '@/lib/kb';
import { publish } from '@/lib/events';
import {
  GENERAL_KEY,
  bodyParams,
  broadcastMessage,
  getBotUser,
  markRead,
  messageById,
  peerKeyOf,
  pollForViewers,
  recipientsOf,
  serializeMessage,
  threadWhere,
  userById,
} from '@/lib/messenger';
import { QueueRejected } from '@/lib/ml/llm';
import type { ChatMessage } from '@/lib/ml/llm';
import { resolveIntent } from '@/lib/ml/intent';
import { answerStream } from '@/lib/ml/pipeline';

// Вопрос ИИ-ассистенту ВНУТРИ переписки сотрудников.
// Порт POST /api/messenger/ask из backend/routes/messenger.py (ask_ai,
// _history_for, _detect_vote_intent, _last_poll_in_thread, _strip_vote_marker,
// _apply_bot_vote).
//
// Ответ не отдаётся в теле: HTTP возвращает только сам вопрос и id заготовки,
// а текст ассистента приходит подписчикам SSE кадрами `ai_stream`
// (queued → start → status → sources → chunk → done).
//
// ОТЛИЧИЯ ОТ PYTHON
// 1. Порядок кадров очереди. В Python запрос ждёт слот ДО начала работы
//    (submit → queued → start → поиск), поэтому QueueRejected прилетает ещё
//    в HTTP-обработчик. Здесь очередь живёт внутри chatStream, то есть уже
//    ПОСЛЕ поиска: сначала start и status, и лишь перед генерацией — queued.
//    Отказ очереди по этой же причине приходит не ответом на запрос, а тем же
//    кадром done с текстом отказа (пользователь видит то же самое).
// 2. Web Push (services/push.py) не шлётся — см. broadcastMessage в lib/messenger.

// Тексты отказа очереди — дословно из services/assistant_queue.py: в lib/ml/llm.ts
// формулировки свои, поэтому сопоставляем по причине.
const QUEUE_REJECT_TEXT: Record<string, string> = {
  queue_full:
    'Сервис ассистента сейчас перегружен — слишком много запросов в очереди. ' +
    'Пожалуйста, попробуйте через минуту.',
  per_user_limit:
    'У вас уже несколько запросов в обработке. Дождитесь ответа ' +
    'на предыдущие, прежде чем отправлять новый.',
};

// ---------------------------------------------------------------------------
// Регэкспы (порты питоновских: \w там знает кириллицу, в JS — нет)
// ---------------------------------------------------------------------------

const W = '[0-9A-Za-zА-Яа-яЁё_]';

/**
 * Мета-вопросы о САМОЙ переписке («о чём мы говорили», «перескажи чат»).
 * Их нельзя гнать через RAG: поиск по такой фразе находит случайные документы
 * базы знаний, и модель пересказывает ИХ вместо истории чата.
 */
const CHAT_META_RE = new RegExp(
  '(о\\s*ч[её]м|про\\s*что)\\s+(эт(от|а|о)\\s+)?(чат|диалог|разговор|беседа|переписк|' +
    'мы\\s+(тут\\s+|здесь\\s+)?(говор|обща|переписыва))' +
    '|что\\s+(тут\\s+|здесь\\s+|у\\s+нас\\s+)?(происходил|обсуждал|обсужда|писал)' +
    '|(перескаж|резюмируй|суммируй|подытож|подведи\\s+итог|краткое\\s+содержани)' +
    '.{0,40}(чат|диалог|переписк|разговор|бесед|сообщени)' +
    '|о\\s*ч[её]м\\s+(шла\\s+)?речь',
  'i'
);

// Требуем ИМПЕРАТИВ, чтобы простое упоминание опроса («что было в голосовании?»)
// не запускало голосование бота.
const VOTE_INTENT_RE = new RegExp(
  `(проголос${W}*|отдай\\s+(свой\\s+)?голос|` +
    `выбери\\s+(любой\\s+|какой[- ]?нибудь\\s+)?(голос|вариант)|` +
    'сделай\\s+выбор\\s+в\\s+голосован|прими\\s+участие\\s+в\\s+голосован|' +
    `поучаству${W}*\\s+в\\s+голосован)`,
  'i'
);
const VOTE_RANDOM_RE = new RegExp(
  `(любой|случайн${W}*|рандом${W}*|наугад|как\\s+хочешь|без\\s+разниц)`,
  'i'
);

// Служебная строка выбора в голосовании (её пишет модель, пользователю НЕ видна):
// «ГОЛОС: 2», «ГОЛС 1», «**ГОЛОС: 1** (за …)», «VOTE: 1». Ловим только как
// ОТДЕЛЬНУЮ строку — чтобы не задеть обычные предложения про голосование.
const VOTE_MARKER =
  '^[^\\S\\r\\n]*[*_#>\\s]*(?:гол[оа]?с(?![а-яё])|vote)[*_\\s]*[:#\\-–—]?[*_\\s]*' +
  '(\\d+)[*_\\s]*(?:\\([^)]*\\))?[*_\\s]*$';
// Два объекта вместо одного: в JS у регэкспа с флагом g состояние (lastIndex)
// общее, и поиск после замены начинался бы с середины строки.
const VOTE_MARKER_SUB_RE = new RegExp(VOTE_MARKER, 'gim');
const VOTE_MARKER_FIND_RE = new RegExp(VOTE_MARKER, 'im');

/** None | 'random' | 'reason' — просит ли пользователь бота проголосовать. */
function detectVoteIntent(content: string): 'random' | 'reason' | null {
  if (!VOTE_INTENT_RE.test(content || '')) return null;
  return VOTE_RANDOM_RE.test(content || '') ? 'random' : 'reason';
}

/** Вырезает служебную строку голосования из ответа модели (в любом виде). */
function stripVoteMarker(text: string): string {
  if (!text) return text;
  return text.replace(VOTE_MARKER_SUB_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function randRange(n: number): number {
  return Math.floor(Math.random() * n);
}

// ---------------------------------------------------------------------------
// Контекст последних сообщений диалога
// ---------------------------------------------------------------------------

/**
 * _history_for: текст + вложения/голосования/реакции последних сообщений.
 * Сообщения пользователей помечаются именем отправителя — иначе модель не знает,
 * кто что писал, и не может отвечать на вопросы о переписке.
 *
 * Связанные строки грузятся пакетно (Python делает по 3-4 запроса на сообщение).
 */
async function historyFor(
  where: Prisma.user_messagesWhereInput,
  beforeId: number,
  limit: number
): Promise<ChatMessage[]> {
  const rows = await prisma.user_messages.findMany({
    where: { AND: [where, { id: { lt: beforeId } }] },
    orderBy: { id: 'desc' },
    take: limit,
  });
  if (!rows.length) return [];
  rows.reverse();
  const ids = rows.map((m) => m.id);

  const [files, pollRows, reactions] = await Promise.all([
    prisma.user_message_files.findMany({
      where: { message_id: { in: ids } },
      orderBy: { id: 'asc' },
    }),
    prisma.polls.findMany({ where: { message_id: { in: ids } }, orderBy: { id: 'asc' } }),
    prisma.user_message_reactions.findMany({
      where: { message_id: { in: ids } },
      orderBy: { id: 'asc' },
    }),
  ]);

  const pollIds = pollRows.map((p) => p.id);
  const [options, votes] = await Promise.all([
    pollIds.length
      ? prisma.poll_options.findMany({
          where: { poll_id: { in: pollIds } },
          orderBy: { position: 'asc' },
        })
      : Promise.resolve<poll_options[]>([]),
    pollIds.length
      ? prisma.poll_votes.findMany({ where: { poll_id: { in: pollIds } }, orderBy: { id: 'asc' } })
      : Promise.resolve<poll_votes[]>([]),
  ]);

  const senderIds = [...new Set(rows.map((m) => m.sender_id))];
  const senders = new Map(
    (await prisma.users.findMany({ where: { id: { in: senderIds } } })).map((u) => [u.id, u])
  );

  const pollByMessage = new Map<number, (typeof pollRows)[number]>();
  for (const p of pollRows) if (!pollByMessage.has(p.message_id)) pollByMessage.set(p.message_id, p);

  const hist: ChatMessage[] = [];
  for (const m of rows) {
    const fm = asDict(m.forwarded_meta);
    if (pyBool(fm.system)) continue; // «закрепил(а) сообщение» и т.п. — шум для модели
    const hasMeta = Object.keys(fm).length > 0;
    const isAi = pyBool(fm.ai);

    const metaText = hasMeta && typeof fm.content === 'string' ? fm.content : '';
    let text = metaText || m.content || '';
    // Пересланный снимок ответа ассистента (из /chat) — помечаем происхождение,
    // чтобы модель не приписывала свой текст пересылающему сотруднику.
    if (hasMeta && !isAi && pyBool(fm.content)) {
      text = `(переслан ответ ИИ-ассистента) ${text}`;
    } else if (pyBool(fm.from_user)) {
      const origin = asDict(fm.from_user).name;
      text = `(переслано от ${pyBool(origin) ? pyStr(origin) : 'другого сотрудника'}) ${text}`;
    }

    const extras: string[] = [];
    const myFiles = files.filter((f) => f.message_id === m.id);
    if (myFiles.length) extras.push('вложения: ' + myFiles.map((f) => f.original_name).join(', '));

    const poll = pollByMessage.get(m.id);
    if (poll) {
      // Варианты + ТЕКУЩИЕ РЕЗУЛЬТАТЫ — модель может рассуждать об итогах
      // («какой вариант победил», «сколько проголосовало»).
      const popts = options.filter((o) => o.poll_id === poll.id);
      const pvotes = votes.filter((v) => v.poll_id === poll.id);
      const perOpt = new Map<number, number>();
      for (const v of pvotes) perOpt.set(v.option_id, (perOpt.get(v.option_id) ?? 0) + 1);
      const totalVoters = new Set(pvotes.map((v) => v.user_id)).size;
      const optsDesc = popts
        .map((o) => `«${o.text}» — ${perOpt.get(o.id) ?? 0} голос(ов)`)
        .join('; ');
      extras.push(`голосование «${poll.question}»: ${optsDesc} (проголосовало: ${totalVoters})`);
    }

    const myReacts = reactions.filter((r) => r.message_id === m.id);
    if (myReacts.length) extras.push('реакции: ' + myReacts.map((r) => r.emoji).join(' '));

    if (extras.length) text = `${text} [${extras.join('; ')}]`.trim();
    if (!text) continue;

    if (!isAi) {
      const u = senders.get(m.sender_id);
      // Полное ФИО (а не «Фамилия И.») — чтобы модель точно знала, кто автор.
      const name = (u ? fullName(u) : '') || 'Сотрудник';
      text = `[${name}]: ${text}`;
    }
    hist.push({ role: isAi ? 'assistant' : 'user', content: text });
  }
  return hist;
}

// ---------------------------------------------------------------------------
// Голосование ботом по просьбе в чате
// ---------------------------------------------------------------------------

interface VotePlan {
  mode: 'random' | 'reason';
  pollId: number;
  msgId: number;
  optionIds: number[];
  texts: string[];
  question: string;
  chosenIdx: number | null;
}

/** _last_poll_in_thread: последнее голосование диалога с непустым списком вариантов. */
async function lastPollInThread(
  where: Prisma.user_messagesWhereInput
): Promise<{ msgId: number; poll: { id: number; question: string; allow_bot: boolean }; options: { id: number; text: string }[] } | null> {
  const msgs = await prisma.user_messages.findMany({
    where,
    orderBy: { id: 'desc' },
    take: 60,
    select: { id: true },
  });
  if (!msgs.length) return null;

  const polls = await prisma.polls.findMany({
    where: { message_id: { in: msgs.map((m) => m.id) } },
    orderBy: { id: 'asc' },
    select: { id: true, message_id: true, question: true, allow_bot: true },
  });
  if (!polls.length) return null;
  const options = await prisma.poll_options.findMany({
    where: { poll_id: { in: polls.map((p) => p.id) } },
    orderBy: { position: 'asc' },
    select: { id: true, text: true, poll_id: true },
  });

  // Идём от свежих сообщений к старым; опрос без вариантов — как будто его нет.
  for (const m of msgs) {
    const poll = polls.find((p) => p.message_id === m.id);
    if (!poll) continue;
    const opts = options.filter((o) => o.poll_id === poll.id);
    if (opts.length) return { msgId: m.id, poll, options: opts };
  }
  return null;
}

/** _apply_bot_vote: засчитывает голос бота ПОСЛЕ генерации ответа. */
async function applyBotVote(vote: VotePlan, answerText: string): Promise<void> {
  try {
    const poll = await prisma.polls.findUnique({ where: { id: vote.pollId } });
    const pollMsg = await messageById(vote.msgId);
    if (!poll || !pollMsg || !vote.optionIds.length || !poll.allow_bot) return;

    let idx: number;
    if (vote.mode === 'random') {
      idx = vote.chosenIdx ?? -1;
      if (idx < 0 || idx >= vote.optionIds.length) idx = randRange(vote.optionIds.length);
    } else {
      const m = VOTE_MARKER_FIND_RE.exec(answerText || '');
      idx = m ? Number(m[1]) - 1 : randRange(vote.optionIds.length);
      if (idx < 0 || idx >= vote.optionIds.length) idx = 0;
    }

    const bot = await getBotUser();
    await prisma.poll_votes.deleteMany({ where: { poll_id: poll.id, user_id: bot.id } });
    await prisma.poll_votes.create({
      data: { poll_id: poll.id, option_id: vote.optionIds[idx], user_id: bot.id },
    });

    const recipients = [...new Set(await recipientsOf(pollMsg))];
    const byViewer = await pollForViewers(pollMsg, recipients);
    for (const uid of recipients) {
      publish(uid, {
        type: 'poll_updated',
        id: pollMsg.id,
        poll: byViewer.get(uid),
        peer_key: peerKeyOf(pollMsg, uid),
      });
    }
  } catch {
    // Python здесь только пишет warning «Голос бота не засчитан» — ответ
    // ассистента всё равно доедет до собеседников.
  }
}

// ---------------------------------------------------------------------------
// POST /api/messenger/ask
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  const user = gate.user;

  const parsed = await bodyParams(request);
  if ('response' in parsed) return parsed.response;
  const p = parsed.params;

  const peerId = p.optInt('peer_id');
  const general = p.bool('general', false);
  const rawContent = p.str('content');
  const invalid = p.invalid();
  if (invalid) return invalid;

  const content = (rawContent || '').trim();
  if (!content) return badRequest('Пустой вопрос');
  let other: Awaited<ReturnType<typeof userById>> = null;
  if (!general) {
    // peer_id == user.id — запрос к ИИ внутри «Заметок» (диалог с собой).
    other = await userById(peerId);
    if (!peerId || !other) return notFound('Получатель не найден');
  }

  // 1) вопрос — обычное сообщение, помеченное как запрос к ассистенту
  const q = await prisma.user_messages.create({
    data: {
      sender_id: user.id,
      recipient_id: general ? null : peerId,
      is_general: general,
      content,
      forwarded_meta: Prisma.DbNull,
      is_pinned: false,
      is_edited: false,
      is_ai_query: true,
    },
  });
  const where = threadWhere(user.id, peerId, general);
  await markRead(user.id, general ? GENERAL_KEY : pyStr(peerId), where);
  await broadcastMessage(q);

  // 2) плейсхолдер ответа ИИ (автор = спросивший, чтобы был на его стороне)
  const ai = await prisma.user_messages.create({
    data: {
      sender_id: user.id,
      recipient_id: general ? null : peerId,
      is_general: general,
      content: '',
      forwarded_meta: { content: '', sources: [], ai: true },
      is_pinned: false,
      is_edited: false,
      is_ai_query: false,
    },
  });
  const aiId = ai.id;

  // Мета-вопрос о самой переписке → отвечаем по истории (без поиска по базе
  // знаний) и берём больше сообщений, чтобы было что пересказывать.
  // Детект: регэксп + контекстный классификатор (ловит перефразировки). Порядок
  // важен — при совпадении регэкспа классификатор не дёргается (как `or` в Python),
  // и запрос не платит за эмбеддинг с возможным LLM-уточнением.
  let history = await historyFor(where, q.id, 5);
  const isMeta =
    CHAT_META_RE.test(content) || (await resolveIntent(content, history)) === 'meta_chat';
  if (isMeta) history = await historyFor(where, q.id, 30);
  const recipients = [...new Set(await recipientsOf(ai))];
  const pkMap = new Map(recipients.map((uid) => [uid, peerKeyOf(ai, uid)]));
  const asker = user.id;

  // Голосование по просьбе: пользователь просит бота проголосовать в опросе.
  // 'reason' — бот высказывает мнение и голосует; 'random' — случайный выбор.
  let vote: VotePlan | null = null;
  const voteMode = detectVoteIntent(content);
  if (voteMode) {
    const vt = await lastPollInThread(where);
    if (vt && vt.poll.allow_bot) {
      vote = {
        mode: voteMode,
        pollId: vt.poll.id,
        msgId: vt.msgId,
        optionIds: vt.options.map((o) => o.id),
        texts: vt.options.map((o) => o.text),
        question: vt.poll.question,
        chosenIdx: voteMode === 'random' ? randRange(vt.options.length) : null,
      };
    }
  }

  // Контекст о чате и участниках — чтобы модель знала, где и с кем общается.
  const askerDesc = fullName(user) + (user.position ? `, должность: ${user.position}` : '');
  let place: string;
  if (general) {
    place = 'Это общий рабочий чат отдела кадров ТИУ со всеми сотрудниками.';
  } else if (peerId === user.id) {
    place =
      'Это личные «Заметки» сотрудника (диалог с самим собой): черновики, напоминания и вопросы к ИИ.';
  } else {
    place =
      `Это личный чат между ${fullName(user)} (${user.position || 'должность не указана'}) и ` +
      `${other ? fullName(other) : 'собеседник'} (${other && other.position ? other.position : 'должность не указана'}).`;
  }

  let extraContext =
    'Ты — ИИ-ассистент отдела кадров ТИУ и сейчас отвечаешь ВНУТРИ переписки между сотрудниками. ' +
    place +
    ` Вопрос задал ${askerDesc}. ` +
    'Учитывай контекст предыдущих сообщений диалога (они в истории) — отвечай в том числе на ' +
    'вопросы о самой беседе («о чём речь», «что обсуждали»), об участниках и о вложениях/голосованиях. ' +
    'ВАЖНО: не приписывай участникам качеств, заслуг, опыта или оценок, которых нет в переписке или ' +
    'базе знаний, и не делай необоснованных выводов о людях. Если фактов недостаточно — так и скажи, ' +
    'а не выдумывай их.';
  if (isMeta) {
    extraContext +=
      ' ВАЖНО: текущий вопрос — о САМОЙ переписке. Отвечай ТОЛЬКО по сообщениям из истории ' +
      'диалога (имена отправителей указаны в квадратных скобках). Не привлекай нормативные ' +
      'документы и не выдумывай темы, которых в сообщениях нет. Если переписка неформальная ' +
      '(приветствия, картинки, шутки) — так и скажи.';
  }
  if (vote) {
    const numbered = vote.texts.map((t, i) => `${i + 1}) ${t}`).join('\n');
    if (vote.mode === 'random') {
      const picked = vote.texts[vote.chosenIdx as number];
      extraContext +=
        ` СЕЙЧАС пользователь просит тебя проголосовать в опросе «${vote.question}» ` +
        `СЛУЧАЙНЫМ образом. Варианты:\n${numbered}\n` +
        `Система засчитает твой голос за вариант «${picked}» — коротко подтверди это, ` +
        'без разбора вариантов и рассуждений.';
    } else {
      extraContext +=
        ` СЕЙЧАС пользователь просит тебя проголосовать в опросе «${vote.question}» ` +
        `и высказать своё мнение. Варианты:\n${numbered}\n` +
        'Своё мнение основывай ТОЛЬКО на фактах из этой переписки и базы знаний. НЕ придумывай ' +
        'личные качества, опыт, заслуги или характеристики участников — если в диалоге их нет, ' +
        'не упоминай их. Если объективных оснований для выбора нет, честно скажи об этом и выбирай ' +
        'наиболее осторожный/нейтральный вариант. ' +
        'В САМОМ КОНЦЕ ответа добавь ОТДЕЛЬНОЙ последней строкой строго «ГОЛОС: N», ' +
        'где N — номер выбранного варианта (только число). Эта строка служебная, ' +
        'пользователю не показывается.';
    }
  }

  /** Один кадр ai_stream всем участникам беседы (у каждого свой peer_key). */
  const publishFrame = (extra: Record<string, unknown>): void => {
    for (const uid of recipients) {
      publish(uid, {
        ...extra,
        type: 'ai_stream',
        id: aiId,
        peer_key: pkMap.get(uid),
        asker_id: asker,
      });
    }
  };

  // after() продлевает жизнь запроса до конца генерации — без него Next может
  // свернуть контекст сразу после ответа и оборвать стрим на первом же кадре.
  after(async () => {
    publishFrame({ phase: 'start', status: 'search' });

    let acc = '';
    let srcs: unknown[] = [];
    try {
      const result = await answerStream(content, {
        history,
        useRag: !isMeta && !vote,
        onStatus: (st) => publishFrame({ phase: 'status', status: st }),
        extraContext,
        allowNoContextAnswer: true,
        // null (а не уже вычисленный интент) — как в Python: для НЕ мета-вопроса
        // пайплайн классифицирует запрос сам, по своей исправленной формулировке.
        intentHint: isMeta ? 'meta_chat' : null,
        userId: asker,
        onPosition: (position, total) =>
          publishFrame({ phase: 'queued', queue_position: position, queue_total: total }),
      });
      srcs = result.sources;
      publishFrame({ phase: 'sources', sources: srcs });
      for await (const chunk of result.stream) {
        acc += chunk;
        publishFrame({ phase: 'chunk', chunk });
      }
    } catch (e) {
      if (!acc) {
        // Отказ очереди в Python прилетает ещё до старта работы и кладётся
        // прямо в плейсхолдер — итог для пользователя тот же.
        acc =
          e instanceof QueueRejected
            ? (QUEUE_REJECT_TEXT[e.reason] ?? e.message)
            : 'Не удалось сформировать ответ: ' + (e instanceof Error ? e.message : String(e));
        if (e instanceof QueueRejected) srcs = [];
      }
    }

    // Голос бота (по просьбе в чате): засчитываем ПОСЛЕ ответа.
    if (vote) await applyBotVote(vote, acc);
    // Служебную строку голосования вырезаем ВСЕГДА — даже если запрос не был
    // про голосование: модель иногда имитирует её из контекста прошлых сообщений.
    // Иначе она попадает в чат и в историю, и имитация усиливается.
    const display = stripVoteMarker(acc);
    try {
      await prisma.user_messages.update({
        where: { id: aiId },
        data: {
          forwarded_meta: {
            content: display,
            sources: srcs,
            ai: true,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch {
      // Заготовку могли удалить — кадр done всё равно отдаём открытым вкладкам.
    }
    publishFrame({ phase: 'done', content: display, sources: srcs });
  });

  return NextResponse.json({
    question: await serializeMessage(q, user.id),
    ai_message_id: aiId,
  });
}
