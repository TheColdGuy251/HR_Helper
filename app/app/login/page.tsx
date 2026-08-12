'use client';
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { apiPost } from '@/lib/api';

// Вход в HR-помощник. Дизайн — карточка авторизации Tyuiu.bot-main,
// логика — JSON-вход FastAPI (POST /api/auth/login: логин ИЛИ почта + пароль).

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!login.trim() || !password.trim()) {
      setError('Укажите логин (или корпоративную почту) и пароль.');
      return;
    }

    setLoading(true);
    try {
      await apiPost(
        '/api/auth/login',
        { username: login.trim(), password },
        { skipAuthRedirect: true }
      );
      const next = searchParams.get('next');
      router.push(next && next.startsWith('/') ? next : '/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка соединения с сервером.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f4f7fc] px-4">
      <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border border-gray-100 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <Image
            src="/images/full-color.svg"
            alt="ТИУ"
            width={120}
            height={36}
            priority
            style={{ width: 'auto', height: '32px' }}
            className="object-contain"
            unoptimized
          />
          <span className="text-sm font-black text-[#0f1c3f] tracking-tight">HR-помощник</span>
        </div>

        <h2 className="text-2xl font-bold text-[#0f1c3f] tracking-tight">
          Вход в корпоративную учётную запись
        </h2>

        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-xs text-blue-800 font-medium">
          Войдите по логину или корпоративной почте (например, ivanov@tyuiu.ru). Если учётной
          записи ещё нет — зарегистрируйтесь по ссылке ниже.
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 p-3 rounded-xl text-xs font-semibold">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-gray-600">Логин или корпоративная почта</label>
            <input
              type="text"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="ivanov или ivanov@tyuiu.ru"
              autoComplete="username"
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-blue-500 text-slate-700"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-gray-600">Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-blue-500 text-slate-700"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#2563eb] text-white py-3 rounded-xl font-bold uppercase tracking-wider text-xs hover:bg-[#1e40af] transition shadow-md disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Проверка...' : 'Войти'}
          </button>
        </form>

        <div className="flex justify-between items-center text-xs text-gray-500 border-t pt-4">
          <span>Нет учётной записи?</span>
          <Link href="/register" className="text-blue-600 font-semibold hover:underline">
            Регистрация
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
