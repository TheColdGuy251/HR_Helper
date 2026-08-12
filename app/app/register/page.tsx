'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiPost } from '@/lib/api';

// Регистрация в HR-помощнике: поля формы FastAPI RegisterForm
// (POST /api/auth/register), дизайн — карточка Tyuiu.bot-main.

const inputCls =
  'w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-blue-500 text-slate-700';
const labelCls = 'text-xs font-semibold text-gray-600';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    surname: '',
    name: '',
    patronymic: '',
    username: '',
    email: '',
    position: 'HR-специалист',
    sex: '',
    password: '',
    password_again: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!form.surname.trim() || !form.name.trim() || !form.username.trim() || !form.email.trim()) {
      setError('Заполните обязательные поля: фамилия, имя, логин, почта.');
      return;
    }
    if (form.password.length < 6) {
      setError('Пароль должен быть не короче 6 символов.');
      return;
    }
    if (form.password !== form.password_again) {
      setError('Пароли не совпадают.');
      return;
    }

    setLoading(true);
    try {
      await apiPost('/api/auth/register', form, { skipAuthRedirect: true });
      router.push('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка соединения с сервером.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f4f7fc] px-4 py-8">
      <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-lg border border-gray-100 flex flex-col gap-5">
        <h2 className="text-2xl font-bold text-[#0f1c3f] tracking-tight">
          Регистрация в HR-помощнике
        </h2>

        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-xs text-blue-800 font-medium">
          Укажите корпоративную почту вида ivanov@tyuiu.ru — по ней выполняется вход наряду с логином.
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 p-3 rounded-xl text-xs font-semibold">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className={labelCls}>Фамилия *</label>
              <input type="text" value={form.surname} onChange={set('surname')} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>Имя *</label>
              <input type="text" value={form.name} onChange={set('name')} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>Отчество</label>
              <input type="text" value={form.patronymic} onChange={set('patronymic')} className={inputCls} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className={labelCls}>Логин *</label>
              <input
                type="text"
                value={form.username}
                onChange={set('username')}
                autoComplete="username"
                className={inputCls}
              />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>Корпоративная почта *</label>
              <input
                type="email"
                value={form.email}
                onChange={set('email')}
                placeholder="ivanov@tyuiu.ru"
                autoComplete="email"
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className={labelCls}>Должность</label>
              <input type="text" value={form.position} onChange={set('position')} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>Пол</label>
              <select value={form.sex} onChange={set('sex')} className={inputCls}>
                <option value="">Не указан</option>
                <option value="male">Мужской</option>
                <option value="female">Женский</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className={labelCls}>Пароль * (мин. 6 символов)</label>
              <input
                type="password"
                value={form.password}
                onChange={set('password')}
                autoComplete="new-password"
                className={inputCls}
              />
            </div>
            <div className="space-y-1">
              <label className={labelCls}>Повтор пароля *</label>
              <input
                type="password"
                value={form.password_again}
                onChange={set('password_again')}
                autoComplete="new-password"
                className={inputCls}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#0f1c3f] text-white py-3 rounded-xl font-bold uppercase tracking-wider text-xs hover:bg-[#1e40af] transition shadow-md disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Создание учётной записи...' : 'Зарегистрироваться'}
          </button>
        </form>

        <div className="flex justify-between items-center text-xs text-gray-500 border-t pt-4">
          <span>Уже есть учётная запись?</span>
          <Link href="/login" className="text-blue-600 font-semibold hover:underline">
            Войти
          </Link>
        </div>
      </div>
    </div>
  );
}
