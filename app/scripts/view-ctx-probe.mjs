// Прогон записей БД через сборку контекста просмотрщика документов
// (lib/file-view.ts): проверка, что ни одна запись не роняет просмотр.
//
// Набор полей ответа - контракт с components/document-viewer.tsx. Функции
// lib/file-view.ts вызываются напрямую (они же стоят за app/api/view/*),
// поэтому пересобирать и перезапускать Next не нужно. С --http=1 вместо этого
// опрашивается запущенный Next - так проверяется ещё и обвязка роутов
// (адреса, 401, разбор параметров).
//
// Режим сверки с прежним бэкендом на :8000 больше не работает: тот несовместим
// с текущей схемой БД.
//
// Запуск:
//   node scripts/view-ctx-probe.mjs                 - всё, что найдётся в БД
//   node scripts/view-ctx-probe.mjs --limit=5       - по 5 записей каждого вида
//   node scripts/view-ctx-probe.mjs --user=<uuid>   - от имени пользователя с этим id
//   node scripts/view-ctx-probe.mjs --only=kb       - kb|template|document|messenger|news
//   node scripts/view-ctx-probe.mjs --http=1        - сверять через запущенный Next
//   node scripts/view-ctx-probe.mjs --verbose       - печатать значения различий
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* .env нет - берём значения из окружения процесса */
}

// Модули приложения - TypeScript с алиасом "@/" и маркером server-only,
// поэтому грузим их через jiti (тот же приём, что в scripts/rag-probe.mjs).
const jiti = createJiti(import.meta.url, {
  alias: {
    '@': ROOT,
    'server-only': path.join(ROOT, 'node_modules/next/dist/compiled/server-only/empty.js'),
  },
});

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const LIMIT = Number(flag('limit', '0')) || Infinity;
const ONLY = flag('only');
const VERBOSE = args.includes('--verbose');
const VIA_HTTP = Boolean(flag('http'));
const PY = (flag('python') || 'http://localhost:8000').replace(/\/+$/, '');
const NEXT = (flag('next') || 'http://localhost:3000').replace(/\/+$/, '');

const { prisma } = await jiti.import(path.join(ROOT, 'lib/db.ts'));
const { signSession, SESSION_COOKIE } = await jiti.import(path.join(ROOT, 'lib/session.ts'));
const view = await jiti.import(path.join(ROOT, 'lib/file-view.ts'));

// пользователь и сессия
// Права влияют только на can_edit документов БЗ, но подписать сессию всё равно
// нужно: обе стороны без неё уводят на логин.

const wantUser = flag('user');
const user = wantUser
  ? await prisma.users.findUnique({ where: { id: wantUser } })
  : ((await prisma.users.findFirst({ where: { is_admin: true }, orderBy: { id: 'asc' } })) ??
    (await prisma.users.findFirst({ orderBy: { id: 'asc' } })));
if (!user) {
  console.error('В БД нет пользователей — некому подписать сессию.');
  process.exit(1);
}
const COOKIE = `${SESSION_COOKIE}=${signSession({ user_id: user.id })}`;
console.log(
  `Пользователь: #${user.id} ${user.username} (admin=${user.is_admin}, kb_editor=${user.is_kb_editor})`
);
console.log(`Наш ответ считается ${VIA_HTTP ? `через HTTP ${NEXT}` : 'прямым вызовом lib/file-view.ts'}\n`);

// Набор проверок
// page - путь страницы, kind+id - запись для lib/file-view.ts.

const cases = [];
const add = (kind, id, query = '') => {
  const page = {
    kb: `/kb/documents/${id}/view`,
    template: `/kb/templates/${id}/view`,
    document: `/documents/${id}/view`,
    messenger: `/messenger/files/${id}/view`,
    news: `/news/media/${id}/view`,
  }[kind];
  const api = {
    kb: `/api/view/kb-document/${id}`,
    template: `/api/view/kb-template/${id}`,
    document: `/api/view/document/${id}`,
    messenger: `/api/view/messenger-file/${id}`,
    news: `/api/view/news-media/${id}`,
  }[kind];
  cases.push({ kind, id, page, api, query });
};
const take = (rows) => (LIMIT === Infinity ? rows : rows.slice(0, LIMIT));
// Заведомо несуществующая запись (раньше - id 999999).
const MISSING_ID = '00000000-0000-7000-8000-000000000000';
const want = (kind) => !ONLY || ONLY === kind;

if (want('kb')) {
  const docs = take(await prisma.kb_documents.findMany({ orderBy: { id: 'asc' } }));
  for (const d of docs) {
    add('kb', d.id);
    add('kb', d.id, 'text=1'); // принудительно извлечённый текст
    add('kb', d.id, 'original=1'); // оригинальное форматирование даже для больших docx
  }
  add('kb', MISSING_ID);

  // ?diff=<id уведомления> - сравнение с прежней версией веб-страницы.
  const notes = await prisma.notifications.findMany({
    where: { document_id: { not: null } },
    orderBy: { id: 'desc' },
    take: 200,
  });
  for (const n of take(notes.filter((n) => n.extra && n.extra.old_content != null))) {
    add('kb', n.document_id, `diff=${n.id}`);
  }
  // Заведомо чужое уведомление - должно молча деградировать в обычный просмотр.
  if (docs.length) add('kb', docs[0].id, `diff=${MISSING_ID}`);
}

const bulk = [
  ['template', () => prisma.doc_templates.findMany({ orderBy: { id: 'asc' } })],
  ['document', () => prisma.my_documents.findMany({ orderBy: { id: 'desc' } })],
  ['messenger', () => prisma.user_message_files.findMany({ orderBy: { id: 'desc' } })],
  ['news', () => prisma.news_media.findMany({ orderBy: { id: 'desc' } })],
];
for (const [kind, load] of bulk) {
  if (!want(kind)) continue;
  for (const row of take(await load())) add(kind, row.id);
  add(kind, MISSING_ID);
}

// получение ответов

async function grab(url) {
  const res = await fetch(url, {
    headers: { cookie: COOKIE, accept: 'application/json' },
    redirect: 'manual',
  });
  const body = await res.text();
  if (res.status >= 300 && res.status < 400) {
    return { status: res.status, location: res.headers.get('location') };
  }
  try {
    return { status: res.status, json: JSON.parse(body) };
  } catch {
    return { status: res.status, raw: body.slice(0, 300) };
  }
}

/** Наш ответ: либо через HTTP, либо прямым вызовом перенесённых функций. */
async function ours(c) {
  if (VIA_HTTP) return grab(`${NEXT}${c.api}${c.query ? `?${c.query}` : ''}`);

  const q = new URLSearchParams(c.query);
  const num = (name) => (q.has(name) ? Number.parseInt(q.get(name), 10) : null);
  const result =
    c.kind === 'kb'
      ? await view.kbDocumentView(c.id, user, {
          text: num('text'),
          diff: q.get('diff'),
          original: num('original'),
        })
      : c.kind === 'template'
        ? await view.kbTemplateView(c.id)
        : c.kind === 'document'
          ? await view.myDocumentView(c.id)
          : c.kind === 'messenger'
            ? await view.messengerFileView(c.id)
            : await view.newsMediaView(c.id);

  if ('serverError' in result) return { status: 500, raw: 'Internal Server Error' };
  if ('redirect' in result) return { status: 302, location: result.redirect };
  return { status: 200, json: result.ctx };
}

// сравнение

const short = (v) => {
  if (v === undefined) return 'undefined';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…(всего ${s.length})` : s;
};

/** Различия двух ответов: статус, редирект, набор ключей и значения. */
function compare(py, js) {
  const diffs = [];
  if (py.status !== js.status) diffs.push(`статус: python=${py.status} next=${js.status}`);
  if (py.location || js.location) {
    if (py.location !== js.location) {
      diffs.push(`Location: python=${short(py.location)} next=${short(js.location)}`);
    }
    return diffs;
  }
  if (!py.json || !js.json) {
    if (py.raw || js.raw) diffs.push(`не-JSON: python=${short(py.raw)} next=${short(js.raw)}`);
    return diffs;
  }
  const keys = [...new Set([...Object.keys(py.json), ...Object.keys(js.json)])].sort();
  for (const k of keys) {
    const inA = k in py.json;
    const inB = k in js.json;
    if (inA !== inB) {
      const v = inA ? py.json[k] : js.json[k];
      diffs.push(`ключ ${k}: ${inA ? 'только в python' : 'только в next'} = ${short(v)}`);
      continue;
    }
    const a = py.json[k];
    const b = js.json[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (!VERBOSE && typeof a === 'string' && typeof b === 'string' && a.length > 400) {
      diffs.push(`${k}: тексты различаются (python ${a.length} симв., next ${b.length} симв.)`);
    } else {
      diffs.push(`${k}: python=${short(a)} | next=${short(b)}`);
    }
  }
  return diffs;
}

let ok = 0;
const failed = [];
for (const c of cases) {
  const label = `${c.page}${c.query ? `?${c.query}` : ''}`;
  let py;
  let js;
  try {
    py = await grab(`${PY}${c.page}?format=json${c.query ? `&${c.query}` : ''}`);
    js = await ours(c);
  } catch (e) {
    failed.push({ label, diffs: [`запрос не выполнен: ${e.message}`] });
    console.log(`x ${label} — ${e.message}`);
    continue;
  }
  const diffs = compare(py, js);
  const mode = py.json?.mode ?? `HTTP ${py.status}`;
  if (!diffs.length) {
    ok += 1;
    console.log(`. ${label} -> ${mode}`);
  } else {
    failed.push({ label, diffs });
    console.log(`x ${label} -> ${mode}`);
    for (const d of diffs) console.log(`      ${d}`);
  }
}

console.log(`\nИтого: ${ok}/${cases.length} совпало, расхождений — ${failed.length}`);
await prisma.$disconnect();
process.exitCode = failed.length ? 1 : 0;
