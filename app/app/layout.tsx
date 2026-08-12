import type { Metadata, Viewport } from 'next';
import { Chrome } from '@/components/chrome';
import './globals.css';

// Корневой layout — серверный компонент (метаданные, PWA), вся клиентская
// логика (авторизация, SSE, шапка) живёт в <Chrome>.

export const metadata: Metadata = {
  title: {
    default: 'HR-помощник ТИУ',
    template: '%s — HR-помощник ТИУ',
  },
  description:
    'ИИ-ассистент отдела кадров ТИУ: база знаний, документы, чат с коллегами и ассистентом',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/images/pwa-192.png',
    apple: '/images/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    title: 'HR-помощник',
    statusBarStyle: 'default',
  },
};

export const viewport: Viewport = {
  themeColor: '#1e40af',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="bg-[#f4f7fc] text-slate-800 antialiased min-h-screen flex flex-col">
        <Chrome>{children}</Chrome>
      </body>
    </html>
  );
}
