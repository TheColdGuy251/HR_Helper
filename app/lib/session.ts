import 'server-only';
import crypto from 'node:crypto';

// Совместимая с FastAPI сессия: читает и пишет ту же cookie `hr_session`,
// что и Starlette SessionMiddleware (itsdangerous.TimestampSigner).
//
// Это ключ к постепенной миграции: пока часть эндпоинтов ещё на Python,
// оба бэкенда понимают сессию друг друга — пользователь не разлогинивается
// при переносе очередного домена.
//
// Формат значения cookie:  base64(json) "." base64url(timestamp) "." base64url(hmac-sha1)
// Подпись считается от строки  base64(json) "." base64url(timestamp).
// Ключ: sha1(salt + "signer" + secret).digest()  — режим "django-concat" itsdangerous.

export const SESSION_COOKIE = 'hr_session';
const SALT = 'itsdangerous.Signer';
const SEP = '.';
// Starlette по умолчанию: 14 дней (см. session_max_age_sec в backend/config.py).
export const SESSION_MAX_AGE = 14 * 24 * 60 * 60;

export interface SessionData {
  user_id?: number;
  [key: string]: unknown;
}

function getSecret(): string {
  const secret = process.env.SECRET_KEY;
  if (!secret) {
    throw new Error(
      'SECRET_KEY не задан. Значение должно совпадать с SECRET_KEY в backend/.env, ' +
        'иначе сессии Next.js и FastAPI будут несовместимы.'
    );
  }
  return secret;
}

/** Ключ подписи в режиме django-concat (как в itsdangerous). */
function deriveKey(secret: string): Buffer {
  return crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(SALT, 'utf8'), Buffer.from('signer', 'utf8'), Buffer.from(secret, 'utf8')]))
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

function signature(value: string, key: Buffer): string {
  return b64urlEncode(crypto.createHmac('sha1', key).update(value, 'utf8').digest());
}

/** Собирает значение cookie для переданных данных сессии. */
export function signSession(data: SessionData, now = Math.floor(Date.now() / 1000)): string {
  const key = deriveKey(getSecret());
  // Starlette кодирует полезную нагрузку обычным base64 (не urlsafe).
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  const ts = b64urlEncode(intToBytes(now));
  const value = `${payload}${SEP}${ts}`;
  return `${value}${SEP}${signature(value, key)}`;
}

/**
 * Разбирает и проверяет cookie. Возвращает null, если подпись неверна,
 * значение испорчено или истёк срок.
 */
export function verifySession(cookieValue: string | undefined | null): SessionData | null {
  if (!cookieValue) return null;

  const lastSep = cookieValue.lastIndexOf(SEP);
  if (lastSep < 0) return null;
  const signedPart = cookieValue.slice(0, lastSep);
  const sig = cookieValue.slice(lastSep + 1);

  const tsSep = signedPart.lastIndexOf(SEP);
  if (tsSep < 0) return null;
  const payload = signedPart.slice(0, tsSep);
  const tsPart = signedPart.slice(tsSep + 1);

  // Сравнение подписи — в постоянном времени.
  let expected: string;
  try {
    expected = signature(signedPart, deriveKey(getSecret()));
  } catch {
    return null;
  }
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Срок годности.
  let issuedAt: number;
  try {
    issuedAt = bytesToInt(b64urlDecode(tsPart));
  } catch {
    return null;
  }
  const age = Math.floor(Date.now() / 1000) - issuedAt;
  if (age > SESSION_MAX_AGE || age < -60) return null; // -60: допуск на рассинхрон часов

  try {
    const json = Buffer.from(payload, 'base64').toString('utf8');
    const data = JSON.parse(json);
    return data && typeof data === 'object' ? (data as SessionData) : null;
  } catch {
    return null;
  }
}

/** Параметры записи cookie — те же флаги, что выставляет Starlette. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: (process.env.SESSION_SAME_SITE || 'lax') as 'lax' | 'strict' | 'none',
    secure: String(process.env.SESSION_HTTPS_ONLY).toLowerCase() === 'true',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  };
}

/**
 * Собирает заголовок Set-Cookie вручную.
 *
 * Через cookies().set() нельзя: Next прогоняет значение через
 * encodeURIComponent, и завершающие '=' base64 превращаются в '%3D'.
 * Starlette декодирование не делает и такую cookie не принимает — сессия,
 * выданная Next.js, переставала работать в FastAPI.
 *
 * Чтение остаётся штатным: decodeURIComponent не портит base64 (символа '%'
 * в нём нет), поэтому cookies().get() возвращает значение как есть.
 */
export function serializeSessionCookie(value: string, maxAge = SESSION_MAX_AGE): string {
  const parts = [`${SESSION_COOKIE}=${value}`, 'path=/', `Max-Age=${maxAge}`, 'httponly'];
  parts.push(`samesite=${process.env.SESSION_SAME_SITE || 'lax'}`);
  if (String(process.env.SESSION_HTTPS_ONLY).toLowerCase() === 'true') parts.push('secure');
  return parts.join('; ');
}
