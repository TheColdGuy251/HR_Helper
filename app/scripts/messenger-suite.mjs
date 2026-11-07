// Тесты ассистента внутри мессенджера (личный чат, "Заметки", общая группа,
// мета-вопросы о переписке, голосование бота в опросе).
//
// Требует поднятый сервер (npm start / start.ps1) - идёт по HTTP как браузер.
// Ответ ассистента ждём через БД (forwarded_meta.content заполняется в конце
// генерации). По завершении созданные сообщения/опрос удаляются.
//
// Использование: node scripts/messenger-suite.mjs [--base http://localhost:3000]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const jiti = createJiti(import.meta.url, {
  alias: {
    '@': ROOT,
    'server-only': path.join(ROOT, 'node_modules/next/dist/compiled/server-only/empty.js'),
  },
});
const { prisma } = await jiti.import(path.join(ROOT, 'lib/db.ts'));

const baseIdx = process.argv.indexOf('--base');
const BASE = baseIdx >= 0 ? process.argv[baseIdx + 1] : 'http://localhost:3000';
const OUT = path.join(HERE, `messenger-suite-${Date.now().toString(36)}.jsonl`);
const out = fs.createWriteStream(OUT, { flags: 'a' });

const TESTER = { username: 'rag_suite_tester', password: 'suite-Passw0rd', email: 'rag-suite@test.local' };

let cookie = '';
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setc = res.headers.getSetCookie?.() ?? [];
  for (const c of setc) if (c.startsWith('hr_session=')) cookie = c.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* пустое тело */ }
  return { status: res.status, data };
}

// вход (регистрация при первом запуске)
let r = await api('POST', '/api/auth/login', { username: TESTER.username, password: TESTER.password });
if (r.status !== 200) {
  r = await api('POST', '/api/auth/register', {
    username: TESTER.username, email: TESTER.email, surname: 'Тестов', name: 'Сьют',
    position: 'инженер по тестированию', password: TESTER.password, password_again: TESTER.password,
  });
  if (r.status >= 400) { console.error('register failed', r.status, r.data); process.exit(1); }
  if (!cookie) {
    r = await api('POST', '/api/auth/login', { username: TESTER.username, password: TESTER.password });
    if (r.status !== 200) { console.error('login failed', r.status, r.data); process.exit(1); }
  }
}
const me = await prisma.users.findUnique({ where: { username: TESTER.username } });
const peer = await prisma.users.findFirst({ where: { username: 'qwerty1' } });
console.log(`вошёл как ${TESTER.username} (id=${me.id}); собеседник: ${peer?.username} (id=${peer?.id})`);

const createdMsgIds = [];
const results = [];

async function waitAnswer(aiId, timeoutMs = 180_000) {
  const t0 = Date.now();
  for (;;) {
    const row = await prisma.user_messages.findUnique({ where: { id: aiId } });
    const meta = row?.forwarded_meta ?? {};
    if (meta && typeof meta === 'object' && meta.content) return { text: meta.content, sources: meta.sources ?? [] };
    if (Date.now() - t0 > timeoutMs) return { text: '(таймаут ожидания ответа)', sources: [] };
    await new Promise((res) => setTimeout(res, 1500));
  }
}

async function ask(label, expect, body) {
  const t0 = Date.now();
  const res = await api('POST', '/api/messenger/ask', body);
  if (res.status >= 400) {
    const rec = { label, expect, body, error: `HTTP ${res.status}: ${JSON.stringify(res.data)}` };
    results.push(rec); out.write(JSON.stringify(rec) + '\n');
    console.log(`⛔ ${label}: HTTP ${res.status}`);
    return null;
  }
  const aiId = res.data.ai_message_id;
  createdMsgIds.push(res.data.question?.id, aiId);
  const ans = await waitAnswer(aiId);
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  const rec = {
    label, expect, content: body.content, general: !!body.general, peer_id: body.peer_id ?? null,
    secs, answer: ans.text, sources: (ans.sources || []).map((s) => s.title || s.source_type).slice(0, 5),
  };
  results.push(rec); out.write(JSON.stringify(rec) + '\n');
  console.log(`▶ ${label} (${secs}s)\n  «${body.content.slice(0, 60)}» → ${String(ans.text).replace(/\s+/g, ' ').slice(0, 110)}`);
  return ans;
}

async function send(body) {
  const res = await api('POST', '/api/messenger/send', body);
  if (res.data?.message?.id) createdMsgIds.push(res.data.message.id);
  return res;
}

// сценарии

// 1. Личный чат: контекст из обычных сообщений + вопрос к ассистенту
await send({ peer_id: peer.id, content: '[тест] Привет! Обсуждаем оформление командировки в Сургут на конференцию.' });
await send({ peer_id: peer.id, content: '[тест] Мне нужно понять, какие документы собрать до отъезда.' });
await ask('личный чат: RAG-вопрос', 'rag', {
  peer_id: peer.id,
  content: 'Какие документы нужны для оформления командировки?',
});
await ask('личный чат: мета-вопрос о переписке', 'meta', {
  peer_id: peer.id,
  content: 'О чём мы тут говорили?',
});
await ask('личный чат: вопрос об участниках', 'meta-participants', {
  peer_id: peer.id,
  content: 'кто участвует в этой переписке и кто что предлагал?',
});

// 2. "Заметки" (диалог с собой)
await ask('заметки: вопрос ассистенту', 'rag', {
  peer_id: me.id,
  content: 'Напомни, какова периодичность повышения квалификации у преподавателей?',
});

// 3. Общая группа
await send({ general: true, content: '[тест] Коллеги, собираем вопросы к HR к пятничной встрече.' });
await ask('общая группа: RAG-вопрос', 'rag', {
  general: true,
  content: 'Сколько дней отпуска у преподавателей по коллективному договору?',
});
await ask('общая группа: пересказ чата', 'meta', {
  general: true,
  content: 'перескажи, что обсуждали в этом чате последнее время',
});

// 4. Опрос в общей группе + голосование бота
const pollRes = await api('POST', '/api/messenger/poll', {
  general: true,
  question: '[тест] Куда пойдём на тимбилдинг?',
  options: ['Боулинг', 'Квиз', 'Каток'],
  allow_bot: true,
});
const pollMsgId = pollRes.data?.message?.id;
if (pollMsgId) createdMsgIds.push(pollMsgId);
console.log(`опрос создан: HTTP ${pollRes.status}, message_id=${pollMsgId}`);
// Голоса этого опроса. Опрос определяется через вариант (poll_id в голосе нет).
// Нулевой UUID вместо undefined: Prisma трактует undefined как "без фильтра".
const pollVotesWhere = {
  option: { poll: { message_id: pollMsgId ?? '00000000-0000-0000-0000-000000000000' } },
};

await ask('голосование: случайный выбор', 'vote-random', {
  general: true,
  content: 'проголосуй в опросе за любой вариант',
});
let botVote = await prisma.poll_votes.findFirst({
  where: pollVotesWhere,
  include: { option: true, user: true },
  orderBy: { created_at: 'desc' },
});
console.log(`  голос бота: ${botVote ? `${botVote.user.username} → «${botVote.option.text}»` : 'НЕ ЗАСЧИТАН'}`);
out.write(JSON.stringify({ label: 'vote-random-check', vote: botVote ? botVote.option.text : null }) + '\n');

await ask('голосование: с обоснованием', 'vote-reason', {
  general: true,
  content: 'проголосуй в этом опросе и объясни свой выбор',
});
botVote = await prisma.poll_votes.findFirst({
  where: pollVotesWhere,
  include: { option: true, user: true },
  orderBy: { created_at: 'desc' },
});
console.log(`  голос бота: ${botVote ? `${botVote.user.username} → «${botVote.option.text}»` : 'НЕ ЗАСЧИТАН'}`);
out.write(JSON.stringify({ label: 'vote-reason-check', vote: botVote ? botVote.option.text : null }) + '\n');

// "что было в голосовании?" - упоминание опроса без императива не должно голосовать
const before = await prisma.poll_votes.count({ where: pollVotesWhere });
await ask('упоминание опроса без просьбы голосовать', 'no-vote', {
  general: true,
  content: 'что было в голосовании и какие результаты?',
});
const after = await prisma.poll_votes.count({ where: pollVotesWhere });
console.log(`  голосов до/после: ${before}/${after} ${before === after ? '(не голосовал — верно)' : '(ПРОГОЛОСОВАЛ — ошибка!)'}`);
out.write(JSON.stringify({ label: 'no-vote-check', before, after }) + '\n');

// уборка
const ids = createdMsgIds.filter(Boolean);
// Опросы, их варианты и голоса удалятся каскадом вместе с сообщениями.
await prisma.user_messages.deleteMany({ where: { id: { in: ids } } });
console.log(`\nубрано тестовых сообщений: ${ids.length}; отчёт: ${OUT}`);
out.end();
process.exit(0);
