import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isoUtc, prisma } from '@/lib/db';
import { fullName, initials, requireAdmin } from '@/lib/auth';

// Сводка для дашборда админки. Период - последние N дней по часовому поясу
// администратора, для сравнения берётся такой же предыдущий отрезок.

const PERIODS = [7, 30, 90, 365];
const DEFAULT_TZ = 'Asia/Yekaterinburg';

function pickTz(raw: string | null): string {
  if (!raw) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: raw });
    return raw;
  } catch {
    return DEFAULT_TZ;
  }
}

type DayRow = { d: Date; n: bigint };
type CountRow = { n: bigint };

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const sp = request.nextUrl.searchParams;
  const requested = Number(sp.get('days'));
  const days = PERIODS.includes(requested) ? requested : 30;
  const tz = pickTz(sp.get('tz'));

  const [bounds] = await prisma.$queryRaw<{ since: Date; prev_since: Date; today: Date }[]>`
    SELECT
      ((date_trunc('day', now() AT TIME ZONE ${tz}) - make_interval(days => ${days - 1}::int)) AT TIME ZONE ${tz}) AS since,
      ((date_trunc('day', now() AT TIME ZONE ${tz}) - make_interval(days => ${2 * days - 1}::int)) AT TIME ZONE ${tz}) AS prev_since,
      (now() AT TIME ZONE ${tz})::date AS today`;
  const { since, prev_since: prevSince, today } = bounds;
  const inPeriod = { gte: since };
  const inPrev = { gte: prevSince, lt: since };

  const [
    usersTotal,
    usersActive,
    usersAdmins,
    usersKbEditors,
    usersNew,
    questions,
    questionsPrev,
    messages,
    messagesPrev,
    documents,
    documentsPrev,
    dialogues,
    dialoguesFinished,
    feedback,
    docsByGenerator,
    kbByStatus,
    kbArchived,
    kbChunks,
    faqActive,
    sourcesEnabled,
    sourcesFailing,
    newsCount,
    piiByAction,
  ] = await Promise.all([
    prisma.users.count(),
    prisma.users.count({ where: { is_active: true } }),
    prisma.users.count({ where: { is_admin: true } }),
    prisma.users.count({ where: { is_kb_editor: true } }),
    prisma.users.count({ where: { created_at: inPeriod } }),
    prisma.chat_messages.count({ where: { role: 'user', created_at: inPeriod } }),
    prisma.chat_messages.count({ where: { role: 'user', created_at: inPrev } }),
    prisma.user_messages.count({ where: { created_at: inPeriod } }),
    prisma.user_messages.count({ where: { created_at: inPrev } }),
    prisma.my_documents.count({ where: { created_at: inPeriod } }),
    prisma.my_documents.count({ where: { created_at: inPrev } }),
    prisma.dialogues.count({ where: { created_at: inPeriod } }),
    prisma.dialogues.count({ where: { created_at: inPeriod, is_finished: true } }),
    prisma.chat_feedback.groupBy({ by: ['rating'], where: { created_at: inPeriod }, _count: { _all: true } }),
    prisma.my_documents.groupBy({ by: ['generator'], where: { created_at: inPeriod }, _count: { _all: true } }),
    prisma.kb_documents.groupBy({ by: ['status'], where: { is_archived: false }, _count: { _all: true } }),
    prisma.kb_documents.count({ where: { is_archived: true } }),
    prisma.kb_documents.aggregate({ where: { is_archived: false }, _sum: { chunks_count: true } }),
    prisma.faq_entries.count({ where: { is_active: true } }),
    prisma.kb_sources.count({ where: { is_enabled: true } }),
    prisma.kb_sources.count({ where: { is_enabled: true, last_status: 'error' } }),
    prisma.news_posts.count({ where: { created_at: inPeriod, is_published: true } }),
    prisma.pii_audit.groupBy({ by: ['action'], where: { at: inPeriod }, _count: { _all: true } }),
  ]);

  const [qDaily, mDaily, dDaily, auDaily, activeNow, activePrev, latency, heat, top] = await Promise.all([
    prisma.$queryRaw<DayRow[]>`
      SELECT (created_at AT TIME ZONE ${tz})::date AS d, count(*) AS n
      FROM chat_messages
      WHERE role = 'user' AND created_at >= ${since}
      GROUP BY 1`,
    prisma.$queryRaw<DayRow[]>`
      SELECT (created_at AT TIME ZONE ${tz})::date AS d, count(*) AS n
      FROM user_messages
      WHERE created_at >= ${since}
      GROUP BY 1`,
    prisma.$queryRaw<DayRow[]>`
      SELECT (created_at AT TIME ZONE ${tz})::date AS d, count(*) AS n
      FROM my_documents
      WHERE created_at >= ${since}
      GROUP BY 1`,
    prisma.$queryRaw<DayRow[]>`
      SELECT d, count(DISTINCT uid) AS n FROM (
        SELECT (m.created_at AT TIME ZONE ${tz})::date AS d, dl.user_id AS uid
        FROM chat_messages m JOIN dialogues dl ON dl.id = m.dialogue_id
        WHERE m.role = 'user' AND m.created_at >= ${since}
        UNION ALL
        SELECT (created_at AT TIME ZONE ${tz})::date, sender_id
        FROM user_messages WHERE created_at >= ${since}
      ) t
      GROUP BY d`,
    activeUsersBetween(since, null),
    activeUsersBetween(prevSince, since),
    prisma.$queryRaw<{ median: number | null; p90: number | null; answers: bigint }[]>`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - created_at)::float8) AS median,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - created_at)::float8) AS p90,
        count(*) AS answers
      FROM chat_messages
      WHERE role = 'assistant' AND is_cancelled = false AND finished_at IS NOT NULL
        AND created_at >= ${since}`,
    prisma.$queryRaw<{ dow: number; hour: number; n: bigint }[]>`
      SELECT extract(isodow FROM created_at AT TIME ZONE ${tz})::int AS dow,
             extract(hour FROM created_at AT TIME ZONE ${tz})::int AS hour,
             count(*) AS n
      FROM chat_messages
      WHERE role = 'user' AND created_at >= ${since}
      GROUP BY 1, 2`,
    prisma.$queryRaw<
      {
        id: string;
        surname: string;
        name: string;
        patronymic: string | null;
        position: string;
        questions: bigint;
        messages: bigint;
        documents: bigint;
      }[]
    >`
      SELECT u.id::text AS id, u.surname, u.name, u.patronymic, u.position,
             coalesce(q.n, 0) AS questions, coalesce(m.n, 0) AS messages, coalesce(d.n, 0) AS documents
      FROM users u
      LEFT JOIN (
        SELECT dl.user_id, count(*) AS n
        FROM chat_messages cm JOIN dialogues dl ON dl.id = cm.dialogue_id
        WHERE cm.role = 'user' AND cm.created_at >= ${since}
        GROUP BY 1
      ) q ON q.user_id = u.id
      LEFT JOIN (
        SELECT sender_id, count(*) AS n FROM user_messages WHERE created_at >= ${since} GROUP BY 1
      ) m ON m.sender_id = u.id
      LEFT JOIN (
        SELECT user_id, count(*) AS n FROM my_documents WHERE created_at >= ${since} GROUP BY 1
      ) d ON d.user_id = u.id
      WHERE coalesce(q.n, 0) + coalesce(m.n, 0) + coalesce(d.n, 0) > 0
      ORDER BY coalesce(q.n, 0) + coalesce(m.n, 0) + coalesce(d.n, 0) DESC, u.surname
      LIMIT 8`,
  ]);

  // Непрерывный ряд дат: дни без событий тоже нужны графику.
  const byDay = (rows: DayRow[]) => new Map(rows.map((r) => [dayKey(r.d), num(r.n)]));
  const q = byDay(qDaily);
  const m = byDay(mDaily);
  const dc = byDay(dDaily);
  const au = byDay(auDaily);
  const daily: { date: string; questions: number; messages: number; documents: number; active_users: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = dayKey(d);
    daily.push({
      date: key,
      questions: q.get(key) ?? 0,
      messages: m.get(key) ?? 0,
      documents: dc.get(key) ?? 0,
      active_users: au.get(key) ?? 0,
    });
  }

  const ratingCount = (r: number) => feedback.find((f) => f.rating === r)?._count._all ?? 0;
  const kbCount = (s: string) => kbByStatus.find((k) => k.status === s)?._count._all ?? 0;

  return NextResponse.json({
    success: true,
    days,
    tz,
    since: isoUtc(since),
    generated_at: isoUtc(new Date()),
    users: {
      total: usersTotal,
      active_accounts: usersActive,
      admins: usersAdmins,
      kb_editors: usersKbEditors,
      new: usersNew,
      active: activeNow,
      active_prev: activePrev,
    },
    assistant: {
      questions,
      questions_prev: questionsPrev,
      dialogues,
      dialogues_finished: dialoguesFinished,
      answers: num(latency[0]?.answers),
      median_seconds: latency[0]?.median ?? null,
      p90_seconds: latency[0]?.p90 ?? null,
      feedback_up: ratingCount(1),
      feedback_down: ratingCount(-1),
    },
    messenger: { messages, messages_prev: messagesPrev },
    documents: {
      total: documents,
      total_prev: documentsPrev,
      by_generator: docsByGenerator
        .map((g) => ({ generator: g.generator, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
    },
    kb: {
      indexed: kbCount('indexed'),
      in_progress: kbCount('pending') + kbCount('parsing'),
      failed: kbCount('failed'),
      archived: kbArchived,
      chunks: kbChunks._sum.chunks_count ?? 0,
      faq_active: faqActive,
      sources_enabled: sourcesEnabled,
      sources_failing: sourcesFailing,
    },
    news: { published: newsCount },
    pii: {
      by_action: piiByAction
        .map((p) => ({ action: p.action, count: p._count._all }))
        .sort((a, b) => b.count - a.count),
    },
    daily,
    heatmap: heat.map((h) => ({ dow: h.dow, hour: h.hour, count: num(h.n) })),
    top_users: top.map((u) => ({
      id: u.id,
      full_name: fullName(u),
      initials: initials(u),
      position: u.position,
      questions: num(u.questions),
      messages: num(u.messages),
      documents: num(u.documents),
    })),
  });
}

/** Сколько разных людей писали ассистенту или коллегам в промежутке [from, to). */
async function activeUsersBetween(from: Date, to: Date | null): Promise<number> {
  const upper = to ?? new Date('9999-12-31T00:00:00Z');
  const [row] = await prisma.$queryRaw<CountRow[]>`
    SELECT count(DISTINCT uid) AS n FROM (
      SELECT dl.user_id AS uid
      FROM chat_messages m JOIN dialogues dl ON dl.id = m.dialogue_id
      WHERE m.role = 'user' AND m.created_at >= ${from} AND m.created_at < ${upper}
      UNION ALL
      SELECT sender_id FROM user_messages WHERE created_at >= ${from} AND created_at < ${upper}
    ) t`;
  return num(row?.n);
}
