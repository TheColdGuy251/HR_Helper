'use client';
import { useAuth } from '@/components/auth-context';
import { StatusPill } from '@/components/ui';

// Профиль пользователя: данные из GET /api/auth/me (FastAPI).
// Дизайн — карточка профиля Tyuiu.bot-main.

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <span className="text-xs text-blue-600 font-bold tracking-wide block">{label}</span>
      {typeof value === 'string' ? (
        <span className="text-slate-600 font-semibold">{value || '—'}</span>
      ) : (
        value
      )}
    </div>
  );
}

export default function ProfilePage() {
  const { user, loading } = useAuth();

  if (loading || !user) {
    return (
      <div className="max-w-5xl w-full mx-auto px-4 py-8 flex-1 flex items-center justify-center">
        <p className="text-sm text-gray-400">Загрузка профиля...</p>
      </div>
    );
  }

  const roles: { label: string; tone: 'blue' | 'emerald' | 'amber' | 'red' }[] = [];
  if (user.is_admin) roles.push({ label: 'Администратор', tone: 'red' });
  if (user.is_kb_editor) roles.push({ label: 'Редактор БЗ', tone: 'blue' });
  if (user.can_access_pii) roles.push({ label: 'Доступ к ПДн', tone: 'amber' });
  if (!roles.length) roles.push({ label: 'Сотрудник', tone: 'emerald' });

  return (
    <div className="max-w-5xl w-full mx-auto px-4 py-8 flex-1 flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-[#0f1c3f] tracking-tight">Профиль</h1>

      <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row gap-8 items-start">
        {/* Левая колонка: аватар */}
        <div className="w-full md:w-56 flex flex-col items-center gap-4 shrink-0">
          <div className="w-28 h-28 bg-blue-100 rounded-full flex items-center justify-center overflow-hidden border border-gray-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={user.sex === 'female' ? '/images/female.svg' : '/images/male.svg'}
              alt=""
              className="w-24 h-24 object-contain mt-3"
            />
          </div>
          <div className="text-center">
            <p className="font-bold text-[#0f1c3f]">{user.short_name}</p>
            <p className="text-xs text-gray-400 mt-0.5">{user.position}</p>
          </div>
        </div>

        {/* Правая колонка: данные */}
        <div className="flex-1 w-full space-y-5 text-sm font-medium">
          <Row
            label="Пользователь"
            value={<span className="text-slate-700 text-base font-bold">{user.full_name}</span>}
          />
          <Row label="Логин" value={user.username} />
          <Row
            label="Корпоративная почта"
            value={<span className="text-slate-600 font-semibold underline">{user.email}</span>}
          />
          <Row label="Должность" value={user.position} />
          <Row
            label="Пол"
            value={user.sex === 'male' ? 'Мужской' : user.sex === 'female' ? 'Женский' : 'Не указан'}
          />

          <div className="space-y-2 pt-2">
            <span className="text-xs text-blue-600 font-bold tracking-wide block">Роли и доступы</span>
            <div className="flex flex-wrap gap-2">
              {roles.map((r) => (
                <StatusPill key={r.label} tone={r.tone}>
                  {r.label}
                </StatusPill>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="text-right text-xs text-gray-400 font-medium px-4">HR-помощник ТИУ · © 2026</div>
    </div>
  );
}
