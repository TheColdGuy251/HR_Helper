import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// В Next.js 16 файл `middleware.ts` переименован в `proxy.ts`.
// Сессию ведёт FastAPI-бэкенд (cookie `hr_session`, подписана Starlette
// SessionMiddleware). Проверить подпись здесь нельзя (секрет знает только
// бэкенд), поэтому делаем оптимистичную проверку наличия cookie:
//  - нет cookie и страница закрытая  -> редирект на /login;
//  - cookie есть, но протухла        -> API вернёт 401, клиент сам уведёт
//    пользователя на /login (см. lib/api.ts).
const SESSION_COOKIE = 'hr_session';
const PUBLIC_PATHS = ['/login', '/register', '/offline.html'];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authenticated = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  if (!isPublic && !authenticated) {
    const url = new URL('/login', request.url);
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (authenticated && (pathname === '/login' || pathname === '/register')) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = {
  // API, ассеты Next и PWA-файлы не трогаем: для fetch редирект на /login
  // вернул бы HTML вместо данных. Все остальные страницы закрыты по умолчанию,
  // поэтому новый раздел не нужно вносить в списки — он защищён сразу.
  matcher: [
    '/((?!api|auth|static|_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|images|icons).*)',
  ],
};
