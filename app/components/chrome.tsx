'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AuthProvider, useAuth } from '@/components/auth-context';
import { EventsBridge, Toaster } from '@/components/events';
import { Header } from '@/components/header';
import { MessengerWidget } from '@/components/messenger/widget';
import { PendingGenerations } from '@/components/pending-generations';
import { ScrollbarAutoHide } from '@/components/scrollbar';

// Клиентский каркас приложения: шапка + SSE-канал + тосты для закрытой части,
// «голый» рендер для публичных страниц (/login, /register).

const PUBLIC_PATHS = ['/login', '/register', '/offline.html'];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function Shell({ children, bare = false }: { children: React.ReactNode; bare?: boolean }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-sm font-semibold text-[#0f1c3f] animate-pulse">
          Загрузка HR-помощника...
        </div>
      </div>
    );
  }

  return (
    <>
      {user && <EventsBridge />}
      {!bare && <Header />}
      <main className="flex-1 flex flex-col">{children}</main>
      <Toaster />
      {user && <PendingGenerations />}
      {user && <MessengerWidget />}
    </>
  );
}

export function Chrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [popup, setPopup] = useState(false);

  // Регистрация service worker (PWA) — один раз на вкладку.
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }
  }, []);

  // /messenger?popup=1 — мессенджер вынесен в отдельное окно: шапка сайта там
  // только отнимает место (порт body.msgr-popup, messenger_page.js:9-12).
  // Читаем location, а не useSearchParams, чтобы не тянуть Suspense в каркас.
  useEffect(() => {
    let flag = false;
    try {
      flag = pathname === '/messenger' && new URLSearchParams(window.location.search).has('popup');
    } catch {
      /* нестандартный URL */
    }
    setPopup(flag);
  }, [pathname]);

  if (isPublic(pathname)) {
    return (
      <>
        <ScrollbarAutoHide />
        <main className="flex-1 flex flex-col">{children}</main>
      </>
    );
  }

  return (
    <AuthProvider>
      <ScrollbarAutoHide />
      <Shell bare={popup}>{children}</Shell>
    </AuthProvider>
  );
}
