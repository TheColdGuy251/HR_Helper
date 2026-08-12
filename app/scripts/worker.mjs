#!/usr/bin/env node
// Планировщик фоновых задач — замена APScheduler из backend/services/tasks.
// Запускается РЯДОМ с `next start` (см. package.json → npm run worker).
//
// Почему отдельный процесс и почему он ходит по HTTP, а не импортирует джобы:
//  1) в Next.js нет «старта приложения»: код модулей исполняется только когда
//     в маршрут пришёл запрос, поэтому таймеру негде жить;
//  2) джобы обязаны выполняться ВНУТРИ процесса Next — там живут подписчики
//     SSE (иначе уведомления никому не дойдут), пул Prisma и замок индексации;
//  3) файл намеренно .mjs: чтобы запустить lib/scheduler.ts напрямую, нужен
//     загрузчик TS и резолвер алиаса «@/», то есть лишняя зависимость. Обычный
//     fetch решает ту же задачу без единого нового пакета.
//
// Переменные окружения (app/.env):
//   CRON_SECRET        — общий секрет с /api/cron/[job]; без него воркер не стартует
//   WORKER_TARGET_URL  — адрес Next (по умолчанию http://127.0.0.1:3000)

import process from 'node:process';

// .env Node сам не читает. process.loadEnvFile появился в Node 20.12 —
// именно поэтому обходимся без dotenv.
try {
  process.loadEnvFile('.env');
} catch {
  /* файла нет или Node старее — значения возьмём из окружения процесса */
}

const BASE = (process.env.WORKER_TARGET_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const SECRET = (process.env.CRON_SECRET || '').trim();

const MINUTE = 60_000;

// Расписание один в один с APScheduler в Python: интервал + момент первого
// запуска (next_run_time). Интервал 0 — «выполнить только при старте».
const SCHEDULE = [
  { job: 'resume-indexing', firstDelay: 0, interval: 0 },
  { job: 'pii-cleanup', firstDelay: 2 * MINUTE, interval: 10 * MINUTE },
  { job: 'documents-freshness', firstDelay: 5 * MINUTE, interval: 24 * 60 * MINUTE },
  { job: 'web-sources', firstDelay: 30 * MINUTE, interval: 30 * MINUTE },
];

const log = (msg) => console.log(`[${new Date().toISOString()}] [worker] ${msg}`);

/** Джобы бывают долгими (обход источников с эмбеддингами) — не наслаиваем. */
const busy = new Set();
const timers = [];
let stopping = false;

async function runJob(job) {
  if (stopping || busy.has(job)) return;
  busy.add(job);
  try {
    const res = await fetch(`${BASE}/api/cron/${job}`, {
      method: 'POST',
      headers: { 'x-cron-secret': SECRET, 'content-type': 'application/json' },
    });
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!res.ok) {
      log(`${job}: HTTP ${res.status} — ${payload?.error ?? text.slice(0, 200)}`);
      return;
    }
    if (payload?.skipped) log(`${job}: пропущен (${payload.detail})`);
    else log(`${job}: ${payload?.ok ? 'ок' : 'ошибка'} за ${payload?.ms ?? '—'} мс — ${payload?.detail ?? ''}`);
  } catch (e) {
    // fetch в Node ждёт заголовки ответа не дольше 5 минут. Долгий проход
    // (обход источников с эмбеддингами) в этот лимит не укладывается: джоб при
    // этом продолжает работать на сервере, там же будет и его итоговый лог.
    // Повторного запуска не случится — на стороне Next стоит защита от наложения.
    if (e?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' || e?.code === 'UND_ERR_HEADERS_TIMEOUT') {
      log(`${job}: идёт дольше 5 мин — результат смотрите в логе Next`);
      return;
    }
    // Сервер ещё не поднялся или его перезапускают — следующий тик повторит.
    log(`${job}: недоступен ${BASE} (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    busy.delete(job);
  }
}

/** Ждём, пока Next начнёт отвечать: воркер обычно стартует раньше сервера. */
async function waitForServer(timeoutMs = 5 * MINUTE) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; !stopping; attempt += 1) {
    try {
      await fetch(BASE, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      log(`сервер ${BASE} отвечает`);
      return true;
    } catch {
      if (Date.now() > deadline) {
        log(`сервер ${BASE} не ответил за ${Math.round(timeoutMs / MINUTE)} мин — работаем вслепую`);
        return false;
      }
      if (attempt === 1) log(`жду сервер ${BASE}…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return false;
}

function schedule() {
  for (const { job, firstDelay, interval } of SCHEDULE) {
    const start = setTimeout(() => {
      void runJob(job);
      if (interval > 0) {
        const t = setInterval(() => void runJob(job), interval);
        timers.push(t);
      }
    }, firstDelay);
    timers.push(start);
    const when = firstDelay === 0 ? 'сразу' : `через ${Math.round(firstDelay / MINUTE)} мин`;
    const every = interval === 0 ? 'однократно' : `каждые ${Math.round(interval / MINUTE)} мин`;
    log(`${job}: первый запуск ${when}, далее ${every}`);
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  for (const t of timers) clearTimeout(t);
  log(`остановка по ${signal}`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (!SECRET) {
  console.error(
    '[worker] CRON_SECRET не задан. Добавьте его в app/.env — тем же значением ' +
      'защищён POST /api/cron/[job], без него джобы запускать некому.'
  );
  process.exit(1);
}

log(`планировщик запущен, цель ${BASE}`);
await waitForServer();
schedule();
