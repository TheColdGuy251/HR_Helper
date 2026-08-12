import 'server-only';
import crypto from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { forbidden, requireUser, unauthorized, type CurrentUser } from './auth';
import { isoUtc, prisma } from './db';
import { pyBool, pyStr } from './kb';
import { DOCS_DIR } from './news';

// Общая логика контура персональных данных — порт backend/services/pii/*
// (auth.py, crypto.py, storage.py, audit.py) и вспомогательных функций
// backend/routes/pii.py (_person_payload, _parse_birth_date, _content_disposition).
//
// Оба бэкенда работают с одними и теми же данными: cookie pii_token, выданная
// FastAPI, должна приниматься Next.js и наоборот, а файл, зашифрованный Python,
// обязан читаться здесь. Поэтому форматы подписи и шифрования воспроизведены
// побайтово, а не «по мотивам».

// ── Токен доступа (services/pii/auth.py) ───────────────────────────────────
// itsdangerous.TimestampSigner: "<payload>.<b64url(ts)>.<b64url(hmac-sha1)>".
// Формат тот же, что у сессионной cookie (см. lib/session.ts), отличаются соль
// и полезная нагрузка. Примитивы в session.ts не экспортированы, поэтому
// повторены здесь — трогать чужой модуль ради этого нельзя.

export const PII_COOKIE = 'pii_token';
export const PII_TOKEN_TTL_SEC = 60 * 15; // 15 минут
const TOKEN_SALT = 'pii-reauth-v1';
const SEP = '.';

function getSecret(): string {
  const secret = process.env.SECRET_KEY;
  if (!secret) {
    throw new Error(
      'SECRET_KEY не задан. Значение должно совпадать с SECRET_KEY в backend/.env, ' +
        'иначе токен доступа к ПДн, выданный Next.js, не примет FastAPI.'
    );
  }
  return secret;
}

/** Ключ подписи в режиме django-concat: sha1(salt + "signer" + secret). */
function signKey(): Buffer {
  return crypto
    .createHash('sha1')
    .update(
      Buffer.concat([
        Buffer.from(TOKEN_SALT, 'utf8'),
        Buffer.from('signer', 'utf8'),
        Buffer.from(getSecret(), 'utf8'),
      ])
    )
    .digest();
}

/** base64url без выравнивающих '=' — так кодирует itsdangerous. */
function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Целое → минимальное число байт big-endian (int_to_bytes из itsdangerous). */
function intToBytes(num: number): Buffer {
  if (num === 0) return Buffer.alloc(0);
  const bytes: number[] = [];
  let n = num;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from(bytes);
}

function bytesToInt(buf: Buffer): number {
  let n = 0;
  for (const b of buf) n = n * 256 + b;
  return n;
}

/** Аналог issue_token: подписывает id пользователя текущей меткой времени. */
export function issueToken(userId: number, now = Math.floor(Date.now() / 1000)): string {
  const value = `${userId}${SEP}${b64urlEncode(intToBytes(now))}`;
  const sig = crypto.createHmac('sha1', signKey()).update(value, 'utf8').digest();
  return `${value}${SEP}${b64urlEncode(sig)}`;
}

/**
 * Аналог unsign(max_age=TTL): проверяет подпись и срок.
 * null — подпись не сошлась, метка испорчена, токен просрочен или «из будущего»
 * (itsdangerous считает отрицательный возраст истёкшим).
 */
function unsignToken(token: string | null | undefined): { payload: string; issuedAt: number } | null {
  if (!token) return null;

  const sigSep = token.lastIndexOf(SEP);
  if (sigSep < 0) return null;
  const signed = token.slice(0, sigSep);
  const sig = token.slice(sigSep + 1);

  // itsdangerous сравнивает РАСКОДИРОВАННЫЕ подписи, поэтому лишнее выравнивание
  // '=' в конце не делает токен невалидным — повторяем это поведение.
  let given: Buffer;
  let expected: Buffer;
  try {
    given = b64urlDecode(sig);
    expected = crypto.createHmac('sha1', signKey()).update(signed, 'utf8').digest();
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  const tsSep = signed.lastIndexOf(SEP);
  if (tsSep < 0) return null;
  const payload = signed.slice(0, tsSep);
  const tsRaw = b64urlDecode(signed.slice(tsSep + 1));
  // bytes_to_int в itsdangerous распаковывает ровно 8 байт (">Q").
  if (tsRaw.length > 8) return null;
  const issuedAt = bytesToInt(tsRaw);

  const age = Math.floor(Date.now() / 1000) - issuedAt;
  if (age > PII_TOKEN_TTL_SEC || age < 0) return null;
  return { payload, issuedAt };
}

/** Полезная нагрузка токена — id пользователя (int() в Python допускает пробелы и знак). */
function payloadUserId(payload: string): number | null {
  return /^\s*[+-]?\d+\s*$/.test(payload) ? Number.parseInt(payload.trim(), 10) : null;
}

export function verifyToken(token: string | null | undefined, userId: number): boolean {
  const res = unsignToken(token);
  return res !== null && payloadUserId(res.payload) === userId;
}

/** Сколько секунд осталось у токена. 0 — токен невалидный/просроченный/чужой. */
export function tokenRemainingSeconds(token: string | null | undefined, userId: number): number {
  const res = unsignToken(token);
  if (!res || payloadUserId(res.payload) !== userId) return 0;
  const elapsed = Date.now() / 1000 - res.issuedAt;
  return Math.max(0, Math.trunc(PII_TOKEN_TTL_SEC - elapsed));
}

/**
 * Заголовок Set-Cookie для pii_token.
 *
 * Через cookies().set() нельзя — Next прогоняет значение через
 * encodeURIComponent, а FastAPI ждёт его как есть (та же причина, что и у
 * serializeSessionCookie). Набор флагов повторяет response.set_cookie в
 * routes/pii.py: httponly + samesite=lax + path=/, без secure.
 */
export function serializePiiCookie(value: string, maxAge = PII_TOKEN_TTL_SEC): string {
  return [`${PII_COOKIE}=${value}`, 'path=/', `Max-Age=${maxAge}`, 'httponly', 'samesite=lax'].join('; ');
}

/** Текущее значение cookie pii_token (null, если её нет). */
export async function readPiiToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(PII_COOKIE)?.value ?? null;
}

/**
 * Аналог Depends(require_pii_access): право can_access_pii + свежий токен.
 * Возвращает пользователя либо готовый ответ 401/403 с текстами из Python.
 */
export async function requirePiiAccess(): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const gate = await requireUser();
  if ('response' in gate) return gate;
  if (!gate.user.can_access_pii) return { response: forbidden('Нет доступа к персональным данным') };
  if (!verifyToken(await readPiiToken(), gate.user.id)) {
    return {
      response: unauthorized('Истёк токен доступа к персональным данным. Введите пароль заново.'),
    };
  }
  return { user: gate.user };
}

// ── Шифрование файлов (services/pii/crypto.py) ─────────────────────────────
// AES-256-GCM, ключ — HKDF-SHA256 из SECRET_KEY с константной солью.
// Формат блоба: [12 байт nonce][ciphertext][16 байт tag]. AESGCM в Python
// дописывает tag в конец шифротекста, node:crypto отдаёт его отдельно — отсюда
// ручная сборка/разбор; побайтово результат совпадает.

const KEY_SALT = Buffer.from('hr-helper-pii-salt-v1', 'utf8');
const KEY_INFO = Buffer.from('pii-file-encryption', 'utf8');
const NONCE_LEN = 12;
const TAG_LEN = 16;

let keyCache: Buffer | null = null;

function fileKey(): Buffer {
  if (keyCache) return keyCache;
  const secret = Buffer.from(process.env.SECRET_KEY || '', 'utf8');
  if (secret.length < 16) {
    throw new Error('SECRET_KEY должен содержать минимум 16 байт для шифрования PII');
  }
  keyCache = Buffer.from(crypto.hkdfSync('sha256', secret, KEY_SALT, KEY_INFO, 32));
  return keyCache;
}

export function encryptBytes(data: Buffer): Buffer {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey(), nonce);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export function decryptBytes(blob: Buffer): Buffer {
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error('Зашифрованный блок слишком короткий');
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey(), blob.subarray(0, NONCE_LEN));
  decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN));
  return Buffer.concat([
    decipher.update(blob.subarray(NONCE_LEN, blob.length - TAG_LEN)),
    decipher.final(),
  ]);
}

// ── Хранилище (services/pii/storage.py) ────────────────────────────────────
// Тот же каталог, что у FastAPI: <docs_dir>/personal.

const PERSONAL_DIR = path.join(DOCS_DIR, 'personal');

/**
 * Путь к файлу хранилища, если он не выходит за пределы каталога.
 * Имя приходит из БД, но проверяем всё равно: подстановка "../" не должна
 * давать доступ к файлам вне personal.
 */
function resolveStored(storageName: string): string | null {
  if (!storageName) return null;
  const target = path.resolve(PERSONAL_DIR, storageName);
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const root = norm(path.resolve(PERSONAL_DIR));
  return norm(target).startsWith(root.endsWith(path.sep) ? root : root + path.sep) ? target : null;
}

/** Сохраняет content зашифрованным, возвращает имя в хранилище и исходный размер. */
export async function storeEncrypted(content: Buffer): Promise<{ storageName: string; size: number }> {
  const storageName = `${crypto.randomUUID().replace(/-/g, '')}.enc`;
  await mkdir(PERSONAL_DIR, { recursive: true });
  await writeFile(path.join(PERSONAL_DIR, storageName), encryptBytes(content));
  return { storageName, size: content.length };
}

/** Расшифрованное содержимое или null, если файла нет на диске. */
export async function loadDecrypted(storageName: string): Promise<Buffer | null> {
  const file = resolveStored(storageName);
  if (!file) return null;
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch {
    return null;
  }
  return decryptBytes(raw);
}

/** Удаление файла; отсутствие файла и ошибки ФС игнорируются, как в Python. */
export async function deleteStoredFile(storageName: string): Promise<void> {
  const file = resolveStored(storageName);
  if (!file) return;
  try {
    await unlink(file);
  } catch {
    /* missing_ok=True + except OSError */
  }
}

// ── Тело запроса в формате pydantic ────────────────────────────────────────

export interface PydanticError {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

/** RequestValidationError: 422 со списком ошибок (pydantic отдаёт их разом). */
export function pydanticErrors(errors: PydanticError[]): NextResponse {
  return NextResponse.json({ detail: errors }, { status: 422 });
}

/**
 * Разбор тела-модели (ReauthRequest, PersonCreate): тело обязательно и должно
 * быть объектом. Отличие от dict = Body(...) в lib/kb.ts — тип ошибки для
 * не-объекта: у BaseModel это model_attributes_type, а не dict_type.
 */
export async function modelBody(
  request: NextRequest,
  /** Уже прочитанное тело (нужно там, где его потом ещё проксируют). */
  prefetched?: string
): Promise<{ body: Record<string, unknown> } | { response: NextResponse }> {
  const raw = prefetched ?? (await request.text());
  const missing: PydanticError = { type: 'missing', loc: ['body'], msg: 'Field required', input: null };
  if (!raw) return { response: pydanticErrors([missing]) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // FastAPI кладёт в loc позицию ошибки в JSON — её здесь не восстановить.
    return {
      response: pydanticErrors([
        { type: 'json_invalid', loc: ['body', 0], msg: 'JSON decode error', input: {} },
      ]),
    };
  }
  if (parsed === null || parsed === undefined) return { response: pydanticErrors([missing]) };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      response: pydanticErrors([
        {
          type: 'model_attributes_type',
          loc: ['body'],
          msg: 'Input should be a valid dictionary or object to extract fields from',
          input: parsed,
        },
      ]),
    };
  }
  return { body: parsed as Record<string, unknown> };
}

// ── Журнал аудита (services/pii/audit.py) ──────────────────────────────────

export async function piiLog(
  userId: number | null,
  action: string,
  opts: { entity?: string | null; entityId?: number | null; extra?: Prisma.InputJsonValue } = {}
): Promise<void> {
  await prisma.pii_audit.create({
    data: {
      user_id: userId,
      action,
      entity: opts.entity ?? null,
      entity_id: opts.entityId ?? null,
      extra: opts.extra ?? Prisma.DbNull,
    },
  });
}

// ── ФИО и дата рождения ────────────────────────────────────────────────────

/** full_name из data/pii.py: непустые части через пробел. */
export function fullName(p: { surname: string; name: string; patronymic: string | null }): string {
  return [p.surname, p.name, p.patronymic || ''].filter(Boolean).join(' ').trim();
}

/**
 * Нормализация ФИО перед записью, как в create_person: пробелы по краям
 * срезаются, а вот пустое отчество остаётся пустой строкой — Python приводит к
 * None только отсутствующее значение (`patronymic.strip() if patronymic else None`).
 */
export function normalizeFio(input: { surname: string; name: string; patronymic: string | null }) {
  return {
    surname: input.surname.trim(),
    name: input.name.trim(),
    patronymic: input.patronymic ? input.patronymic.trim() : null,
  };
}

/** Признак ошибки формата даты — вызывающий отдаёт 400, как HTTPException в Python. */
export const BAD_DATE = Symbol('bad-birth-date');

/**
 * Аналог _parse_birth_date: принимает DD.MM.YYYY и YYYY-MM-DD.
 * Диапазоны цифр и допуск однозначных дня/месяца — как у strptime.
 */
export function parseBirthDate(s: string | null | undefined): Date | null | typeof BAD_DATE {
  if (!s) return null;
  const v = s.trim();
  if (!v) return null;

  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  const parts = dotted
    ? { y: +dotted[3], m: +dotted[2], d: +dotted[1] }
    : iso
      ? { y: +iso[1], m: +iso[2], d: +iso[3] }
      : null;
  if (!parts) return BAD_DATE;

  const { y, m, d } = parts;
  if (m < 1 || m > 12 || d < 1 || d > 31) return BAD_DATE;
  // Дата хранится как DATE — фиксируем полночь UTC, иначе часовой пояс сдвинет день.
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return BAD_DATE; // 31.02 и подобное — datetime в Python тоже не примет
  }
  return date;
}

/** date.isoformat() для колонки DATE (в БД лежит полночь UTC). */
export function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** strftime('%d.%m.%Y') для подсказки при полных тёзках. */
export function ruDate(isoValue: string): string {
  const [y, m, d] = isoValue.split('-');
  return `${d}.${m}.${y}`;
}

// ── Представление карточки (routes/pii.py::_person_payload) ────────────────

export interface PersonRow {
  id: number;
  surname: string;
  name: string;
  patronymic: string | null;
  birth_date: Date | null;
  meta: Prisma.JsonValue;
  created_at: Date;
}

export interface DocumentRow {
  id: number;
  original_filename: string;
  mime_type: string | null;
  size_bytes: number;
  note: string | null;
  uploaded_at: Date;
}

export interface PersonPayload {
  id: number;
  surname: string;
  name: string;
  patronymic: string | null;
  birth_date: string | null;
  full_name: string;
  meta: unknown;
  created_at: string | null;
  documents_count?: number;
  documents?: {
    id: number;
    filename: string;
    mime_type: string | null;
    size_bytes: number;
    note: string | null;
    uploaded_at: string | null;
  }[];
  full_name_with_dob?: string;
}

/** `p.meta or {}`: в Python пустой контейнер тоже даёт {}. */
function metaOrEmpty(meta: Prisma.JsonValue): unknown {
  if (!meta || (Array.isArray(meta) && meta.length === 0)) return {};
  return meta;
}

/**
 * documents уже должны быть отсортированы по uploaded_at DESC — Python сортирует
 * их в _person_payload, здесь это делает ORDER BY при выборке.
 */
export function personPayload(
  p: PersonRow,
  opts: { documents?: DocumentRow[]; documentsCount?: number; withCount?: boolean } = {}
): PersonPayload {
  const data: PersonPayload = {
    id: p.id,
    surname: p.surname,
    name: p.name,
    patronymic: p.patronymic,
    birth_date: isoDate(p.birth_date),
    full_name: fullName(p),
    meta: metaOrEmpty(p.meta),
    created_at: isoUtc(p.created_at),
  };
  if (opts.withCount !== false) {
    data.documents_count = opts.documentsCount ?? opts.documents?.length ?? 0;
  }
  if (opts.documents) {
    data.documents = opts.documents.map((d) => ({
      id: d.id,
      filename: d.original_filename,
      mime_type: d.mime_type,
      size_bytes: d.size_bytes,
      note: d.note,
      uploaded_at: isoUtc(d.uploaded_at),
    }));
  }
  return data;
}

// ── Эвристический детектор ПДн (services/pii/scan.py) ──────────────────────
// А8: в ОБЩЕЙ базе знаний не должно быть персональных данных. Детектор
// полностью детерминированный (без LLM) и вызывается при индексации документа
// и при генерации документа по шаблону.
//
// В Python `\b` и `\w` знают кириллицу, в JS — только ASCII, поэтому границу
// слова и класс слова подставляем явно (тот же приём, что в lib/ml/pipeline.ts).

const PII_W = '0-9A-Za-zА-Яа-яЁё_';
const PII_B = `(?:(?<![${PII_W}])(?=[${PII_W}])|(?<=[${PII_W}])(?![${PII_W}]))`;

function piiRe(pattern: string, flags = ''): RegExp {
  return new RegExp(pattern.replace(/\\b/g, PII_B).replace(/\\w/g, `[${PII_W}]`), flags);
}

// Полное ФИО: третье слово — отчество (…вич/…вна/…ична/…ичны). Требование
// отчества отсекает случайные тройки заглавных слов («Российской Федерации …»).
const FIO_FULL_RE = piiRe(
  '\\b([А-ЯЁ][а-яё]{2,})\\s+([А-ЯЁ][а-яё]{2,})\\s+' +
    '([А-ЯЁ][а-яё]+(?:вич|вна|ична|ичны|оглы|кызы))\\b',
  'g'
);

// Маркеры критичных идентификаторов (достаточно одного класса + любых ФИО)
const PII_ID_MARKERS: [string, RegExp][] = [
  ['СНИЛС', piiRe('\\bСНИЛС\\b|\\b\\d{3}-\\d{3}-\\d{3}[- ]\\d{2}\\b', 'i')],
  ['паспорт', piiRe('паспорт\\w*\\s+(серия|сери\\w|№|номер)|серия\\s+\\d{4}\\s+№?\\s*\\d{6}', 'i')],
  ['дата рождения', piiRe('дата\\s+рождени|г\\.\\s?р\\.\\s*\\d{2}\\.\\d{2}\\.\\d{4}|\\bродил[ас]', 'i')],
  ['табельный номер', piiRe('табельн\\w+\\s+номер', 'i')],
  ['личное дело', piiRe('личн\\w+\\s+дел\\w+\\s+№', 'i')],
];

// Порог «похоже на список сотрудников»: столько РАЗНЫХ полных ФИО в тексте
// у нормативного акта не бывает (подписанты — 1–3).
const FIO_LIST_THRESHOLD = 6;

export interface PiiSignals {
  fio_count: number;
  markers: string[];
  samples: string[];
  reason: string;
}

/**
 * Признаки ПДн в тексте или null, если документ чист. Предупреждение
 * срабатывает, если разных полных ФИО ≥ 6 (похоже на список людей) ЛИБО есть
 * полное ФИО И критичный идентификатор (СНИЛС/паспорт/дата рождения…).
 */
export function scanPiiSignals(text: string): PiiSignals | null {
  if (!text) return null;
  const sample = text.slice(0, 500_000); // достаточно и дёшево

  FIO_FULL_RE.lastIndex = 0;
  const fios = new Set<string>();
  for (const m of sample.matchAll(FIO_FULL_RE)) fios.add(`${m[1]} ${m[2]} ${m[3]}`);
  const markers = PII_ID_MARKERS.filter(([, rx]) => rx.test(sample)).map(([name]) => name);

  const listy = fios.size >= FIO_LIST_THRESHOLD;
  const combo = fios.size > 0 && markers.length > 0;
  if (!listy && !combo) return null;

  // Образцы маскируем: «Иванов И.» — достаточно, чтобы редактор понял, о ком речь.
  const mask = (fio: string) => {
    const parts = fio.split(' ');
    return parts.length > 1 ? `${parts[0]} ${parts[1].slice(0, 1)}.` : parts[0];
  };

  return {
    fio_count: fios.size,
    markers,
    samples: [...fios].slice(0, 3).map(mask).sort(),
    reason: listy
      ? 'много ФИО (похоже на список сотрудников)'
      : `ФИО рядом с идентификаторами: ${markers.join(', ')}`,
  };
}

// Инструменты, чьи документы всегда построены на персональных данных работников.
const PII_TEMPLATE_KEYS = new Set([
  'characteristic', // Б1: характеристика на награду
  'employee_certificate', // Б3: справка на работника
  'dpo_report', // Б2: отчёт по ДПО (списки обученных)
  'dismissed_inventory', // Б4: опись личных дел уволенных
]);

/**
 * Порт detect_pii_document: документ относится к ПДн, если это документ
 * ПДн-инструмента либо сканер находит ПДн в значениях полей. Такие документы
 * скрыты из «Моих документов» и удаляются по TTL.
 */
export function detectPiiDocument(templateKey: string | null, texts: unknown[]): boolean {
  if (PII_TEMPLATE_KEYS.has(templateKey || '')) return true;
  const joined = texts.filter(pyBool).map(pyStr).join('\n');
  return Boolean(joined) && scanPiiSignals(joined) !== null;
}

// ── Отдача файла ───────────────────────────────────────────────────────────

/** urllib.parse.quote(s) с safe='/'. */
function pyQuote(s: string): string {
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~/-]/.test(ch)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** _content_disposition: ASCII-fallback + RFC 5987 для кириллических имён. */
export function contentDisposition(filename: string | null): string {
  const name = filename || 'document';
  // name.encode("ascii", "ignore") — символы вне ASCII просто выбрасываются.
  const ascii =
    Array.from(name)
      .filter((ch) => (ch.codePointAt(0) ?? 0) < 128)
      .join('')
      .trim() || 'document';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${pyQuote(name)}`;
}
