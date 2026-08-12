'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, BellOff, LayoutDashboard, RotateCcw, Settings as SettingsIcon, User } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { ErrorCallout, PageHeader, PageShell } from '@/components/ui';

// Настройки учётной записи: то, чем пользователь действительно может управлять.
// Данные профиля правит администратор — сюда вынесены push-уведомления и
// раскладка интерфейса, которая хранится в localStorage.

type PushState = 'loading' | 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

const PUSH_TEXT: Record<PushState, string> = {
  loading: 'Проверяем…',
  unsupported: 'Браузер не поддерживает push-уведомления',
  unavailable: 'Push отключён на сервере: не настроены VAPID-ключи',
  denied: 'Уведомления запрещены в настройках браузера — разрешите их в адресной строке',
  off: 'Выключены: о новых сообщениях узнаете, только когда вкладка открыта',
  on: 'Включены: уведомления придут, даже если вкладка закрыта',
};

/** Ключи раскладки, которые копятся в localStorage (панель, сайдбары). */
const LAYOUT_KEYS = [
  'msgrPanelSize',
  'msgrPanelPos',
  'msgrPinned',
  'mpSidebarCollapsed',
  'chatSidebarCollapsed',
];

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6 flex flex-col gap-4">
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const { user, loading } = useAuth();
  const [push, setPush] = useState<PushState>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [layoutReset, setLayoutReset] = useState(false);

  // Текущее состояние подписки: разрешение браузера + наличие подписки в SW.
  const refreshPush = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPush('unsupported');
      return;
    }
    try {
      const { available } = await apiGet<{ key: string; available: boolean }>(
        '/api/push/vapid-public-key'
      );
      if (!available) {
        setPush('unavailable');
        return;
      }
    } catch {
      setPush('unavailable');
      return;
    }
    if (Notification.permission === 'denied') {
      setPush('denied');
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    setPush((await reg.pushManager.getSubscription()) ? 'on' : 'off');
  }, []);

  useEffect(() => {
    refreshPush();
  }, [refreshPush]);

  const enablePush = async () => {
    setBusy(true);
    setError('');
    try {
      const { key } = await apiGet<{ key: string; available: boolean }>('/api/push/vapid-public-key');
      if (Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          setPush(perm === 'denied' ? 'denied' : 'off');
          return;
        }
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        // base64url → Uint8Array: applicationServerKey принимает только байты.
        const rawKey = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
        const appKey = new Uint8Array([...rawKey].map((c) => c.charCodeAt(0)));
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
      }
      await apiPost('/api/push/subscribe', {
        subscription: { ...sub.toJSON(), ua: navigator.userAgent },
      });
      setPush('on');
    } catch {
      setError('Не удалось включить уведомления. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  const disablePush = async () => {
    setBusy(true);
    setError('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Сначала снимаем на сервере: если отписка в браузере пройдёт, а запрос
        // упадёт, сервер продолжит слать уведомления в мёртвый endpoint.
        await apiPost('/api/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setPush('off');
    } catch {
      setError('Не удалось отключить уведомления.');
    } finally {
      setBusy(false);
    }
  };

  const resetLayout = () => {
    LAYOUT_KEYS.forEach((k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        /* приватный режим — молча пропускаем */
      }
    });
    setLayoutReset(true);
  };

  if (loading || !user) {
    return (
      <PageShell>
        <p className="text-sm text-gray-400">Загрузка настроек…</p>
      </PageShell>
    );
  }

  const pushBusyOrLocked = busy || push === 'loading' || push === 'unsupported' || push === 'unavailable';

  return (
    <PageShell>
      <PageHeader
        icon={SettingsIcon}
        title="Настройки"
        subtitle="Уведомления и внешний вид приложения. Данные учётной записи меняет администратор."
      />

      {error && <ErrorCallout>{error}</ErrorCallout>}

      <Card>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-[#2563eb] flex items-center justify-center shrink-0">
            <Bell size={20} />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#0f1c3f]">Уведомления в браузере</h2>
            <p className="text-sm text-gray-500 mt-1">{PUSH_TEXT[push]}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={push === 'on' ? disablePush : enablePush}
            disabled={pushBusyOrLocked || push === 'denied'}
            className={`px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center gap-2 transition disabled:opacity-40 ${
              push === 'on'
                ? 'text-red-500 hover:bg-red-50 border border-red-100'
                : 'bg-[#2563eb] text-white hover:bg-[#1e40af]'
            }`}
          >
            {push === 'on' ? <BellOff size={16} /> : <Bell size={16} />}
            {push === 'on' ? 'Отключить уведомления' : 'Включить уведомления'}
          </button>
        </div>
      </Card>

      <Card>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-[#2563eb] flex items-center justify-center shrink-0">
            <LayoutDashboard size={20} />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#0f1c3f]">Внешний вид</h2>
            <p className="text-sm text-gray-500 mt-1">
              Положение и размер плавающей панели мессенджера, а также свёрнутые боковые панели
              запоминаются в этом браузере. Сброс вернёт их к исходному виду.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={resetLayout}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold text-slate-600 border border-gray-200 hover:border-blue-200 hover:text-[#2563eb] inline-flex items-center gap-2 transition"
          >
            <RotateCcw size={16} /> Сбросить раскладку
          </button>
          {layoutReset && (
            <span className="text-xs font-medium text-emerald-600">
              Готово — изменения появятся после обновления страницы
            </span>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-[#2563eb] flex items-center justify-center shrink-0">
            <User size={20} />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#0f1c3f]">Учётная запись</h2>
            <p className="text-sm text-gray-500 mt-1">
              {user.full_name} · {user.email}
            </p>
          </div>
        </div>
        <Link
          href="/profile"
          className="text-sm font-semibold text-[#2563eb] hover:text-[#1e40af] transition"
        >
          Открыть профиль →
        </Link>
      </Card>
    </PageShell>
  );
}
