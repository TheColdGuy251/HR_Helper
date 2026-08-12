'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { BookOpen, LogOut, Settings, ShieldCheck, User as UserIcon, Users } from 'lucide-react';
import { useAuth } from '@/components/auth-context';
import { NotificationsBell } from '@/components/notifications';

// Шапка приложения в стиле Tyuiu.bot-main: плавающая белая «пилюля».
// Навигация — разделы HR-помощника (бывший base.html).

// Текстом в шапке — только то, чем пользуются каждый день.
const NAV_LINKS = [
  { href: '/', label: 'Главная', exact: true },
  { href: '/dialogues', label: 'Диалоги', alsoActive: '/chat' },
  { href: '/messenger', label: 'Мессенджер' },
  { href: '/news', label: 'Новости' },
];

// Остальные разделы — иконками рядом с уведомлениями: заходят туда реже, а
// текстом они растягивали навигацию и вытесняли её на мобильных.
const ICON_LINKS: { href: string; label: string; icon: LucideIcon; adminOnly?: boolean }[] = [
  { href: '/kb', label: 'База знаний', icon: BookOpen },
  { href: '/audit', label: 'Аудит ПДн', icon: ShieldCheck, adminOnly: true },
  { href: '/admin', label: 'Админка', icon: Users, adminOnly: true },
];

// ── Аватар по полу (порт loadAvatarIcon из scripts.js) ──────────────────────
// Пол приходит из /api/auth/me в разных написаниях, поэтому нормализуем.

const MALE_VALUES = ['мужской', 'м', 'male', 'm'];
const FEMALE_VALUES = ['женский', 'ж', 'female', 'f'];

function avatarSrc(sex?: string | null): string {
  const s = (sex || '').trim().toLowerCase();
  if (MALE_VALUES.includes(s)) return '/images/male.svg';
  if (FEMALE_VALUES.includes(s)) return '/images/female.svg';
  return '';
}

/** Картинка по полу; пол неизвестен или файл не загрузился — показываем инициалы. */
export function UserAvatar({
  sex,
  initials,
  className = 'w-9 h-9',
}: {
  sex?: string | null;
  initials?: string | null;
  className?: string;
}) {
  const src = avatarSrc(sex);
  const [failed, setFailed] = useState(false);

  // Сменился пользователь — снова пробуем загрузить картинку.
  useEffect(() => setFailed(false), [src]);

  const showImage = Boolean(src) && !failed;
  return (
    <div
      className={`${className} rounded-xl flex items-center justify-center overflow-hidden shadow-inner shrink-0 ${
        showImage ? 'bg-blue-100' : 'bg-amber-400 text-white font-black text-sm tracking-wider'
      }`}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          aria-hidden="true"
          className="w-full h-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        initials || '…'
      )}
    </div>
  );
}

/** Меню по клику на карточку пользователя: профиль, настройки, выход. */
function ProfileMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Закрытие по клику вне и по Esc — как у колокольчика уведомлений.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Учётная запись"
        className="flex items-center gap-3 hover:opacity-80 transition select-none cursor-pointer"
      >
        <div className="hidden sm:flex flex-col items-end leading-tight">
          <span className="font-semibold text-sm text-slate-700">{user?.short_name || ''}</span>
          <span className="text-[10px] text-gray-400">{user?.position || ''}</span>
        </div>
        <UserAvatar sex={user?.sex} initials={user?.initials} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-56 bg-white border border-gray-100 rounded-2xl shadow-lg py-1.5 animate-fade-in z-[95]"
        >
          <div className="px-4 py-2 border-b border-gray-50 mb-1">
            <p className="text-sm font-bold text-[#0f1c3f] truncate">{user?.full_name || ''}</p>
            <p className="text-[11px] text-gray-400 truncate">{user?.email || ''}</p>
          </div>

          <Link
            href="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-blue-50 hover:text-[#2563eb] transition"
          >
            <UserIcon size={16} /> Профиль
          </Link>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-blue-50 hover:text-[#2563eb] transition"
          >
            <Settings size={16} /> Настройки
          </Link>

          <div className="border-t border-gray-50 mt-1 pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                logout();
              }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-semibold text-red-500 hover:bg-red-50 transition"
            >
              <LogOut size={16} /> Выйти
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  const { user } = useAuth();

  const isActive = (link: { href: string; exact?: boolean; alsoActive?: string }) => {
    if (link.exact) return pathname === link.href;
    return (
      pathname === link.href ||
      pathname.startsWith(`${link.href}/`) ||
      (link.alsoActive ? pathname.startsWith(link.alsoActive) : false)
    );
  };

  const iconLinks = ICON_LINKS.filter((l) => !l.adminOnly || user?.is_admin);

  return (
    <header className="bg-white mx-4 mt-4 px-6 py-3 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between gap-4 relative z-[70]">
      {/* Только логотип — как в легаси (base.html:47-53). Подпись «HR-помощник»
          рядом с ним вела туда же и дублировала его. */}
      <Link
        href="/"
        title="HR-помощник ТИУ"
        className="flex items-center hover:opacity-90 transition shrink-0"
      >
        <Image
          src="/images/full-color.svg"
          alt="HR-помощник ТИУ"
          width={140}
          height={40}
          priority
          style={{ width: 'auto', height: '36px' }}
          className="object-contain"
          unoptimized
        />
      </Link>

      {/* Навигация центрируется по СТРАНИЦЕ, а не по остатку строки: логотип
          слева и блок пользователя справа разной ширины, поэтому при обычном
          justify-between середина уезжает вправо. Абсолютное позиционирование
          с translate ставит её ровно по центру шапки; на узких экранах правило
          выключается (lg), и nav снова участвует в потоке. */}
      <nav className="flex gap-4 xl:gap-6 text-sm font-semibold text-gray-500 overflow-x-auto lg:absolute lg:left-1/2 lg:-translate-x-1/2">
        {NAV_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`transition whitespace-nowrap ${
              isActive(link) ? 'text-[#2563eb]' : 'hover:text-[#2563eb]'
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-4 shrink-0">
        <div className="flex items-center gap-1 text-gray-400 border-r pr-4 border-gray-100">
          {iconLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              title={link.label}
              aria-label={link.label}
              className={`p-2 rounded-xl transition ${
                isActive(link)
                  ? 'text-[#2563eb] bg-blue-50'
                  : 'hover:text-[#2563eb] hover:bg-blue-50'
              }`}
            >
              <link.icon size={18} />
            </Link>
          ))}
          <NotificationsBell />
        </div>

        <ProfileMenu />
      </div>
    </header>
  );
}
