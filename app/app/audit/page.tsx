'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, RotateCw, Shield, ShieldAlert } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { PageShell, PageHeader, SecondaryButton, ErrorCallout } from '@/components/ui';

// Журнал аудита действий с ПДн. Порт static/js/audit.js
// (роут — routes/audit.py: GET /api/audit/pii).

interface AuditRow {
  id: number;
  at: string;
  user_id: number | null;
  user_name: string | null;
  user_email: string | null;
  action: string;
  entity: string | null;
  entity_id: number | null;
  extra: unknown;
}

const PAGE = 50;

// Варианты фильтра — как в audit.html
const ACTION_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Все действия' },
  { value: 'reauth_ok', label: 'Вход в раздел' },
  { value: 'reauth_fail', label: 'Ошибка входа' },
  { value: 'view_person', label: 'Просмотр карточки' },
  { value: 'create_person', label: 'Создание карточки' },
  { value: 'delete_person', label: 'Удаление карточки' },
  { value: 'upload', label: 'Загрузка документа' },
  { value: 'download', label: 'Скачивание документа' },
  { value: 'delete', label: 'Удаление документа' },
  { value: 'quick_analyze', label: 'Быстрая загрузка (анализ)' },
];

// Короткие подписи в таблице — как в audit.js
const ACTION_LABELS: Record<string, string> = {
  reauth_ok: 'Вход',
  reauth_fail: 'Ошибка входа',
  view_person: 'Просмотр',
  create_person: 'Создание карточки',
  delete_person: 'Удаление карточки',
  upload: 'Загрузка',
  download: 'Скачивание',
  delete: 'Удаление',
  quick_analyze: 'Анализ файла',
};

// Цвет пилюли действия
const ACTION_TONES: Record<string, string> = {
  reauth_ok: 'bg-emerald-50 text-emerald-600',
  reauth_fail: 'bg-red-50 text-red-600',
  view_person: 'bg-blue-50 text-[#2563eb]',
  create_person: 'bg-emerald-50 text-emerald-600',
  delete_person: 'bg-red-50 text-red-600',
  upload: 'bg-blue-50 text-[#2563eb]',
  download: 'bg-blue-50 text-[#2563eb]',
  delete: 'bg-red-50 text-red-600',
  quick_analyze: 'bg-amber-50 text-amber-600',
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
}

/** Плашка «недостаточно прав» для не-администраторов. */
function AccessDenied() {
  return (
    <div className="max-w-5xl w-full mx-auto px-4 py-8 flex-1 flex items-center justify-center">
      <div className="bg-white border border-gray-100 rounded-2xl p-10 shadow-sm text-center max-w-md w-full">
        <ShieldAlert className="mx-auto text-red-500 mb-3" size={40} />
        <h2 className="text-lg font-bold text-[#0f1c3f]">Недостаточно прав</h2>
        <p className="text-sm text-gray-500 mt-1">Раздел доступен только администраторам.</p>
        <Link href="/" className="inline-block mt-4 text-sm font-semibold text-[#2563eb] hover:underline">
          На главную
        </Link>
      </div>
    </div>
  );
}

export default function AuditPage() {
  const { user, loading } = useAuth();

  const [items, setItems] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (off: number, act: string, uid: string) => {
    setBusy(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(off) });
    if (act) params.set('action', act);
    const uidTrim = uid.trim();
    if (uidTrim && /^\d+$/.test(uidTrim)) params.set('user_id', uidTrim);
    try {
      const d = await apiGet<{ items: AuditRow[]; total: number }>(`/api/audit/pii?${params.toString()}`);
      setItems(d.items ?? []);
      setTotal(d.total ?? 0);
      setOffset(off);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!loading && user?.is_admin) load(0, '', '');
  }, [loading, user, load]);

  if (loading || !user) {
    return (
      <div className="max-w-5xl w-full mx-auto px-4 py-8 flex-1 flex items-center justify-center">
        <p className="text-sm text-gray-400">Загрузка...</p>
      </div>
    );
  }
  if (!user.is_admin) return <AccessDenied />;

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  return (
    <PageShell wide>
      <PageHeader
        icon={Shield}
        title="Журнал аудита"
        subtitle="История действий с персональными данными: кто, что и когда смотрел, загружал, удалял."
      />

      {/* Фильтры */}
      <div className="flex flex-col sm:flex-row gap-3">
        <select
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            load(0, e.target.value, userId);
          }}
          className="bg-white border border-gray-100 rounded-2xl shadow-sm px-4 py-3 text-sm text-slate-600 focus:outline-none focus:border-[#2563eb]"
        >
          {ACTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          inputMode="numeric"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load(0, action, userId);
          }}
          placeholder="Фильтр по ID пользователя"
          className="flex-1 bg-white border border-gray-100 rounded-2xl shadow-sm px-4 py-3 text-sm text-slate-600 focus:outline-none focus:border-[#2563eb]"
        />
        <SecondaryButton onClick={() => load(0, action, userId)} disabled={busy}>
          <RotateCw size={16} /> Обновить
        </SecondaryButton>
      </div>

      {error && <ErrorCallout>{error}</ErrorCallout>}

      {/* Таблица журнала */}
      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wider border-b border-gray-100">
              <th className="px-5 py-3 font-semibold">Время</th>
              <th className="px-5 py-3 font-semibold">Пользователь</th>
              <th className="px-5 py-3 font-semibold">Действие</th>
              <th className="px-5 py-3 font-semibold">Объект</th>
              <th className="px-5 py-3 font-semibold">Доп.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {busy ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-gray-400">
                  Загрузка…
                </td>
              </tr>
            ) : !items.length ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-gray-400">
                  Записей не найдено
                </td>
              </tr>
            ) : (
              items.map((r) => {
                const extraJson = r.extra ? JSON.stringify(r.extra) : '';
                return (
                  <tr key={r.id} className="hover:bg-gray-50 transition">
                    <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtTime(r.at)}</td>
                    <td className="px-5 py-3">
                      {r.user_id ? (
                        <>
                          <div className="text-sm font-semibold text-[#0f1c3f]">{r.user_name || '—'}</div>
                          <div className="text-xs text-gray-400">
                            {r.user_email || ''} (#{r.user_id})
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-block text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${
                          ACTION_TONES[r.action] || 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {ACTION_LABELS[r.action] || r.action}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-700">
                      {r.entity ? (
                        <>
                          <span className="font-semibold">{r.entity}</span>
                          {r.entity_id ? ` #${r.entity_id}` : ''}
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {extraJson && (
                        <span
                          title={extraJson}
                          className="block max-w-[240px] truncate text-xs text-gray-400 font-mono"
                        >
                          {extraJson}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Пагинация */}
      <div className="flex items-center justify-center gap-4">
        <SecondaryButton
          disabled={busy || offset <= 0}
          onClick={() => load(Math.max(0, offset - PAGE), action, userId)}
        >
          <ChevronLeft size={16} /> Назад
        </SecondaryButton>
        <span className="text-xs text-gray-400 font-medium">
          {total ? `${from}–${to} из ${total}` : 'нет данных'}
        </span>
        <SecondaryButton
          disabled={busy || offset + PAGE >= total}
          onClick={() => load(offset + PAGE, action, userId)}
        >
          Вперёд <ChevronRight size={16} />
        </SecondaryButton>
      </div>
    </PageShell>
  );
}
