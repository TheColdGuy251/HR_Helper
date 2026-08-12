import 'server-only';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from './db';
import { SESSION_COOKIE, serializeSessionCookie, signSession, verifySession } from './session';

// Авторизация в точности повторяет поведение FastAPI (backend/utils/auth_deps.py
// и utils/security.py): та же сессионная cookie, тот же bcrypt, те же коды
// ответов и тексты ошибок — фронтенду всё равно, кто обслужил запрос.

export interface CurrentUser {
  id: number;
  username: string;
  email: string;
  surname: string;
  name: string;
  patronymic: string | null;
  position: string;
  sex: string | null;
  is_active: boolean;
  is_admin: boolean;
  is_kb_editor: boolean;
  can_access_pii: boolean;
  created_at: Date;
}

// ── Пароли ─────────────────────────────────────────────────────────────────
// bcrypt в Python обрезает пароль до 72 байт (utils/security.py:_prepare),
// поэтому обрезаем так же — иначе длинные пароли перестанут подходить.

const MAX_PW_BYTES = 72;

function preparePassword(password: string): string {
  const buf = Buffer.from(password, 'utf8');
  return buf.length <= MAX_PW_BYTES ? password : buf.subarray(0, MAX_PW_BYTES).toString('utf8');
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(preparePassword(password), 12); // rounds=12 — как в бэкенде
}

export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  try {
    return await bcrypt.compare(preparePassword(password), hashed);
  } catch {
    return false;
  }
}

// ── Текущий пользователь ───────────────────────────────────────────────────

/** Читает пользователя по сессионной cookie. null, если сессии нет или она протухла. */
export async function currentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  const data = verifySession(store.get(SESSION_COOKIE)?.value);
  const userId = data?.user_id;
  if (typeof userId !== 'number') return null;

  const user = await prisma.users.findUnique({ where: { id: userId } });
  return user as CurrentUser | null;
}

/** Ответ 401 в формате FastAPI (HTTPException отдаёт {"detail": ...}). */
export function unauthorized(detail = 'Требуется авторизация') {
  return NextResponse.json({ detail }, { status: 401 });
}

export function forbidden(detail = 'Доступ запрещён') {
  return NextResponse.json({ detail }, { status: 403 });
}

export function notFound(detail = 'Не найдено') {
  return NextResponse.json({ detail }, { status: 404 });
}

export function badRequest(detail: string) {
  return NextResponse.json({ detail }, { status: 400 });
}

export function conflict(detail: string) {
  return NextResponse.json({ detail }, { status: 409 });
}

/**
 * Аналог Depends(require_user). Возвращает либо пользователя, либо готовый
 * ответ 401 — вызывающий код делает `if ('response' in gate) return gate.response`.
 */
export async function requireUser(): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const user = await currentUser();
  if (!user) return { response: unauthorized() };
  return { user };
}

/** Аналог Depends(require_admin). */
export async function requireAdmin(): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const user = await currentUser();
  if (!user) return { response: unauthorized() };
  if (!user.is_admin) return { response: forbidden('Доступ только для администраторов') };
  return { user };
}

/** Аналог Depends(require_kb_editor): редактор БЗ или администратор. */
export async function requireKbEditor(): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const user = await currentUser();
  if (!user) return { response: unauthorized() };
  if (!user.is_admin && !user.is_kb_editor) {
    return {
      response: forbidden('Нужна роль «редактор базы знаний» — обратитесь к администратору'),
    };
  }
  return { user };
}

// ── Управление сессией ─────────────────────────────────────────────────────
// Cookie ставится заголовком вручную (см. serializeSessionCookie): штатный
// cookies().set() кодирует значение и ломает совместимость с FastAPI.

/** Добавляет к ответу сессионную cookie для указанного пользователя. */
export function withSession(response: NextResponse, userId: number): NextResponse {
  response.headers.append('Set-Cookie', serializeSessionCookie(signSession({ user_id: userId })));
  return response;
}

/** Добавляет к ответу удаление сессионной cookie. */
export function withoutSession(response: NextResponse): NextResponse {
  response.headers.append('Set-Cookie', serializeSessionCookie('', 0));
  return response;
}

// ── Представление пользователя для клиента ─────────────────────────────────
// Формат должен совпадать с _user_json из backend/routes/auth.py.

export function fullName(u: CurrentUser): string {
  return [u.surname, u.name, u.patronymic || ''].filter(Boolean).join(' ').trim();
}

export function shortName(u: CurrentUser): string {
  const first = (u.name || '').trim();
  return `${u.surname}${first ? ` ${first[0]}.` : ''}`.trim();
}

export function initials(u: CurrentUser): string {
  const first = (u.name || '').trim().slice(0, 1);
  const last = (u.surname || '').trim().slice(0, 1);
  return (last + first).toUpperCase();
}

export function userJson(u: CurrentUser) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    surname: u.surname,
    name: u.name,
    patronymic: u.patronymic,
    full_name: fullName(u),
    short_name: shortName(u),
    initials: initials(u),
    position: u.position,
    sex: u.sex || 'unknown',
    is_admin: u.is_admin,
    is_kb_editor: u.is_kb_editor,
    can_access_pii: u.can_access_pii,
  };
}
