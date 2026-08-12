'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Bot,
  Eye,
  Paperclip,
  RotateCw,
  ShieldAlert,
  Trash2,
  User as UserIcon,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { apiDelete, apiGet, apiPatch } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { PageShell, PageHeader, SecondaryButton, ErrorCallout, SearchInput, PillTabs } from '@/components/ui';
import { formatMessageContent } from '@/lib/msgfmt';

// Администрирование: управление пользователями, роли, просмотр переписок,
// журнал действий. Порт static/js/admin.js (роуты — routes/admin.py).

interface AdminUser {
  id: number;
  full_name: string;
  short_name: string;
  initials: string;
  email: string;
  username: string;
  position: string | null;
  is_active: boolean;
  is_admin: boolean;
  is_kb_editor: boolean;
  can_access_pii: boolean;
  created_at: string | null;
}

interface DialogueItem {
  id: number;
  title: string;
  is_finished: boolean;
  last_activity: string | null;
  messages: number;
}

interface DialogueMsg {
  id: number;
  role: string;
  content: string;
  sources: number;
  created_at: string | null;
}

interface ConvItem {
  key: string;
  title: string;
  count: number;
  last_at: string | null;
}

interface PeerMsg {
  id: number;
  sender_id: number;
  sender_name: string;
  is_target: boolean;
  content: string;
  forwarded: boolean;
  attachments: string[];
  created_at: string | null;
}

interface ActivityData {
  stats: { dialogues: number; sent_messages: number; files: number };
  audit: { id: number; at: string | null; action: string; entity: string | null; entity_id: number | null }[];
}

type RoleKey = 'is_admin' | 'is_kb_editor' | 'can_access_pii' | 'is_active';
type DrawerTab = 'dialogues' | 'messenger' | 'activity';

const ROLES: { key: RoleKey; label: string }[] = [
  { key: 'is_admin', label: 'Администратор' },
  { key: 'is_kb_editor', label: 'Редактор БЗ' },
  { key: 'can_access_pii', label: 'Доступ к ПДн' },
  { key: 'is_active', label: 'Активен' },
];

// Расшифровка действий с ПДн (как в admin.js)
const ACTION_LABEL: Record<string, string> = {
  reauth_ok: 'Вход в раздел ПДн',
  reauth_fail: 'Ошибка входа в ПДн',
  view_person: 'Просмотр карточки',
  create_person: 'Создание карточки',
  delete_person: 'Удаление карточки',
  upload: 'Загрузка документа',
  download: 'Скачивание документа',
  delete: 'Удаление документа',
  quick_analyze: 'Быстрый анализ',
  timeout_save: 'Автовыход по таймауту',
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Неизвестная ошибка');

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

export default function AdminPage() {
  const { user, loading } = useAuth();
  const me = user?.id ?? 0;

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Состояние выдвижной панели
  const [drawerUser, setDrawerUser] = useState<AdminUser | null>(null);
  const [tab, setTab] = useState<DrawerTab>('dialogues');
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [dialogues, setDialogues] = useState<DialogueItem[] | null>(null);
  const [thread, setThread] = useState<{ title: string; items: DialogueMsg[] } | null>(null);
  const [convs, setConvs] = useState<ConvItem[] | null>(null);
  const [convThread, setConvThread] = useState<{ title: string; items: PeerMsg[] } | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setError(null);
    try {
      const d = await apiGet<{ items: AdminUser[] }>('/api/admin/users');
      setUsers(d.items ?? []);
    } catch (e) {
      setError(`Не удалось загрузить пользователей: ${errMsg(e)}`);
    } finally {
      setUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loading && user?.is_admin) loadUsers();
  }, [loading, user, loadUsers]);

  // Закрытие панели по Escape
  useEffect(() => {
    if (!drawerUser) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerUser(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerUser]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => (u.full_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)
    );
  }, [users, query]);

  async function toggleRole(u: AdminUser, key: RoleKey) {
    setError(null);
    try {
      const d = await apiPatch<{ item: AdminUser }>(`/api/admin/users/${u.id}`, { [key]: !u[key] });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, ...d.item } : x)));
    } catch (e) {
      setError(`Не удалось изменить права: ${errMsg(e)}`);
    }
  }

  async function deleteUser(u: AdminUser) {
    if (
      !window.confirm(
        `Удалить пользователя «${u.full_name}»?\n\nБудут безвозвратно удалены его диалоги с ботом и переписки. Действие необратимо.`
      )
    )
      return;
    setError(null);
    try {
      await apiDelete(`/api/admin/users/${u.id}`);
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      if (drawerUser?.id === u.id) setDrawerUser(null);
    } catch (e) {
      setError(`Не удалось удалить: ${errMsg(e)}`);
    }
  }

  // ─── загрузчики вкладок панели ───
  const loadDialogues = useCallback(async (uid: number) => {
    setDrawerLoading(true);
    setDrawerError(null);
    try {
      const d = await apiGet<{ items: DialogueItem[] }>(`/api/admin/users/${uid}/dialogues`);
      setDialogues(d.items ?? []);
    } catch (e) {
      setDrawerError(errMsg(e));
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  const loadMessenger = useCallback(async (uid: number) => {
    setDrawerLoading(true);
    setDrawerError(null);
    try {
      const d = await apiGet<{ items: ConvItem[] }>(`/api/admin/users/${uid}/messenger`);
      setConvs(d.items ?? []);
    } catch (e) {
      setDrawerError(errMsg(e));
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  const loadActivity = useCallback(async (uid: number) => {
    setDrawerLoading(true);
    setDrawerError(null);
    try {
      const d = await apiGet<ActivityData>(`/api/admin/users/${uid}/activity`);
      setActivity(d);
    } catch (e) {
      setDrawerError(errMsg(e));
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  function openDrawer(u: AdminUser) {
    setDrawerUser(u);
    setTab('dialogues');
    setDialogues(null);
    setConvs(null);
    setActivity(null);
    setThread(null);
    setConvThread(null);
    setDrawerError(null);
    loadDialogues(u.id);
  }

  function switchTab(t: DrawerTab) {
    if (!drawerUser) return;
    setTab(t);
    setThread(null);
    setConvThread(null);
    setDrawerError(null);
    if (t === 'dialogues') loadDialogues(drawerUser.id);
    else if (t === 'messenger') loadMessenger(drawerUser.id);
    else loadActivity(drawerUser.id);
  }

  async function openDialogue(did: number) {
    if (!drawerUser) return;
    setDrawerLoading(true);
    setDrawerError(null);
    try {
      const d = await apiGet<{ title: string; items: DialogueMsg[] }>(
        `/api/admin/users/${drawerUser.id}/dialogues/${did}/messages`
      );
      setThread({ title: d.title, items: d.items ?? [] });
    } catch (e) {
      setDrawerError(errMsg(e));
    } finally {
      setDrawerLoading(false);
    }
  }

  async function openConversation(key: string, title: string) {
    if (!drawerUser) return;
    setDrawerLoading(true);
    setDrawerError(null);
    try {
      const d = await apiGet<{ items: PeerMsg[] }>(
        `/api/admin/users/${drawerUser.id}/messenger/${encodeURIComponent(key)}`
      );
      setConvThread({ title, items: d.items ?? [] });
    } catch (e) {
      setDrawerError(errMsg(e));
    } finally {
      setDrawerLoading(false);
    }
  }

  const canGoBack = (tab === 'dialogues' && !!thread) || (tab === 'messenger' && !!convThread);
  function goBack() {
    if (tab === 'dialogues') setThread(null);
    else if (tab === 'messenger') setConvThread(null);
  }

  if (loading || !user) {
    return (
      <div className="max-w-5xl w-full mx-auto px-4 py-8 flex-1 flex items-center justify-center">
        <p className="text-sm text-gray-400">Загрузка...</p>
      </div>
    );
  }
  if (!user.is_admin) return <AccessDenied />;

  return (
    <PageShell wide>
      <PageHeader
        icon={UserCog}
        title="Администрирование"
        subtitle="Управление пользователями и правами, просмотр переписок с ботом и коллегами, журнал действий с данными."
        actions={
          <SecondaryButton onClick={loadUsers}>
            <RotateCw size={16} /> Обновить
          </SecondaryButton>
        }
      />

      {/* className="w-full": прямой потомок вертикального PageShell — flex-1 растянул бы
          поиск по высоте и отбросил список пользователей к низу окна. */}
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Поиск по ФИО или e-mail…"
        className="w-full"
      />

      {error && <ErrorCallout>{error}</ErrorCallout>}

      {/* Список пользователей */}
      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
        {usersLoading ? (
          <p className="text-center text-gray-400 py-10 text-sm">Загрузка…</p>
        ) : !filtered.length ? (
          <p className="text-center text-gray-400 py-10 text-sm">Ничего не найдено</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {filtered.map((u) => (
              <div
                key={u.id}
                onClick={() => openDrawer(u)}
                className={`flex flex-col lg:flex-row lg:items-center gap-3 px-5 py-4 hover:bg-gray-50 transition cursor-pointer ${
                  u.is_active ? '' : 'opacity-60'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0 lg:w-72 shrink-0">
                  <span className="w-10 h-10 rounded-full bg-blue-100 text-[#2563eb] font-bold text-sm flex items-center justify-center shrink-0">
                    {u.initials}
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold text-[#0f1c3f] text-sm truncate">
                      {u.full_name}
                      {u.id === me && (
                        <span className="ml-2 text-[10px] font-bold uppercase bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full align-middle">
                          вы
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 truncate">
                      {u.email}
                      {u.position ? ` · ${u.position}` : ''}
                    </div>
                  </div>
                </div>

                {/* Пилюли ролей: клик переключает право */}
                <div className="flex flex-wrap gap-1.5 flex-1">
                  {ROLES.map((r) => {
                    const on = u[r.key];
                    // Себе нельзя снять админку/активность (бэкенд тоже запрещает)
                    const locked = u.id === me && (r.key === 'is_admin' || r.key === 'is_active');
                    return (
                      <button
                        key={r.key}
                        type="button"
                        disabled={locked}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRole(u, r.key);
                        }}
                        title={locked ? 'Нельзя изменить у себя' : `${on ? 'Снять' : 'Выдать'}: ${r.label}`}
                        className={`text-[11px] font-bold px-2.5 py-1 rounded-full transition ${
                          on
                            ? 'bg-blue-50 text-[#2563eb] hover:bg-blue-100'
                            : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                        } ${locked ? 'opacity-60 cursor-not-allowed' : ''}`}
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>

                <div className="text-xs text-gray-400 lg:w-32 shrink-0">{fmtDate(u.created_at)}</div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDrawer(u);
                    }}
                    title="Просмотр переписок и действий"
                    className="p-2 rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-blue-50 transition"
                  >
                    <Eye size={16} />
                  </button>
                  <button
                    type="button"
                    disabled={u.id === me}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteUser(u);
                    }}
                    title="Удалить пользователя"
                    className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Выдвижная панель просмотра пользователя ─── */}
      {drawerUser && (
        <>
          {/* Слои: шапка сайта — z-[70], поэтому панель и её подложка идут выше,
              по общей шкале модалок (89/90). С прежними z-40/z-50 панель
              рисовалась под шапкой. */}
          <div className="fixed inset-0 bg-black/30 z-[89]" onClick={() => setDrawerUser(null)} />
          <aside className="fixed top-0 right-0 h-full w-full max-w-xl bg-white z-[90] shadow-2xl border-l border-gray-100 flex flex-col">
            {/* Шапка панели */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
              {canGoBack && (
                <button
                  type="button"
                  onClick={goBack}
                  aria-label="Назад"
                  className="p-2 rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-blue-50 transition"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <div className="font-bold text-[#0f1c3f] truncate">{drawerUser.full_name}</div>
                <div className="text-xs text-gray-400 truncate">{drawerUser.email}</div>
              </div>
              <button
                type="button"
                onClick={() => setDrawerUser(null)}
                aria-label="Закрыть"
                className="p-2 rounded-lg text-gray-400 hover:text-slate-700 hover:bg-gray-100 transition"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-5 pt-4">
              <PillTabs<DrawerTab>
                tabs={[
                  { key: 'dialogues', label: 'Диалоги' },
                  { key: 'messenger', label: 'Мессенджер' },
                  { key: 'activity', label: 'Активность' },
                ]}
                active={tab}
                onChange={switchTab}
              />
            </div>

            {/* Тело панели */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {drawerLoading ? (
                <p className="text-center text-gray-400 py-10 text-sm">Загрузка…</p>
              ) : drawerError ? (
                <ErrorCallout>{drawerError}</ErrorCallout>
              ) : tab === 'dialogues' ? (
                thread ? (
                  <div className="flex flex-col gap-3">
                    <div className="font-semibold text-[#0f1c3f] text-sm">{thread.title}</div>
                    {!thread.items.length && (
                      <p className="text-center text-gray-400 py-10 text-sm">Пусто</p>
                    )}
                    {thread.items.map((m) => (
                      <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                            m.role === 'user'
                              ? 'bg-[#2563eb] text-white'
                              : 'bg-gray-50 text-slate-700 border border-gray-100'
                          }`}
                        >
                          <div className="text-[11px] font-semibold opacity-70 mb-1">
                            {m.role === 'user' ? drawerUser.short_name : 'Бот'} · {fmtDate(m.created_at)}
                          </div>
                          {m.role === 'user' ? (
                            <div className="whitespace-pre-wrap break-words">{m.content || '—'}</div>
                          ) : (
                            <div
                              className="msg-md"
                              dangerouslySetInnerHTML={{ __html: formatMessageContent(m.content) }}
                            />
                          )}
                          {m.sources > 0 && (
                            <div className="text-[11px] opacity-60 mt-1">источников: {m.sources}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : !dialogues?.length ? (
                  <p className="text-center text-gray-400 py-10 text-sm">Нет диалогов с ботом</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {dialogues.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => openDialogue(d.id)}
                        className="text-left bg-white border border-gray-100 rounded-xl px-4 py-3 hover:border-[#2563eb] hover:shadow-sm transition"
                      >
                        <div className="flex items-center gap-2 text-sm font-semibold text-[#0f1c3f]">
                          <Bot size={16} className="text-[#2563eb] shrink-0" />
                          <span className="truncate">{d.title}</span>
                        </div>
                        <div className="text-xs text-gray-400 mt-1">
                          {d.messages} сообщ. · {fmtDate(d.last_activity)}
                          {d.is_finished && (
                            <span className="ml-2 text-[10px] font-bold uppercase bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full">
                              решён
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : tab === 'messenger' ? (
                convThread ? (
                  <div className="flex flex-col gap-3">
                    <div className="font-semibold text-[#0f1c3f] text-sm">{convThread.title}</div>
                    {!convThread.items.length && (
                      <p className="text-center text-gray-400 py-10 text-sm">Пусто</p>
                    )}
                    {convThread.items.map((m) => (
                      <div key={m.id} className={`flex ${m.is_target ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                            m.is_target
                              ? 'bg-[#2563eb] text-white'
                              : 'bg-gray-50 text-slate-700 border border-gray-100'
                          }`}
                        >
                          <div className="text-[11px] font-semibold opacity-70 mb-1">
                            {m.sender_name} · {fmtDate(m.created_at)}
                          </div>
                          <div className="whitespace-pre-wrap break-words">
                            {m.forwarded && (
                              <span
                                className={`mr-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                                  m.is_target ? 'bg-white/20' : 'bg-gray-200 text-gray-500'
                                }`}
                              >
                                переслано
                              </span>
                            )}
                            {m.content || (m.attachments.length ? '' : '—')}
                          </div>
                          {m.attachments.length > 0 && (
                            <div className="flex flex-col gap-1 mt-2">
                              {m.attachments.map((a, i) => (
                                <span key={i} className="flex items-center gap-1.5 text-xs opacity-80">
                                  <Paperclip size={12} className="shrink-0" /> {a}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : !convs?.length ? (
                  <p className="text-center text-gray-400 py-10 text-sm">Нет переписок</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {convs.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => openConversation(c.key, c.title)}
                        className="text-left bg-white border border-gray-100 rounded-xl px-4 py-3 hover:border-[#2563eb] hover:shadow-sm transition"
                      >
                        <div className="flex items-center gap-2 text-sm font-semibold text-[#0f1c3f]">
                          {c.key === 'general' ? (
                            <Users size={16} className="text-[#2563eb] shrink-0" />
                          ) : (
                            <UserIcon size={16} className="text-[#2563eb] shrink-0" />
                          )}
                          <span className="truncate">{c.title}</span>
                        </div>
                        <div className="text-xs text-gray-400 mt-1">
                          {c.count} сообщ. · {fmtDate(c.last_at)}
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : activity ? (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 text-center">
                      <div className="text-xl font-bold text-[#0f1c3f]">{activity.stats.dialogues || 0}</div>
                      <div className="text-xs text-gray-500 mt-0.5">диалогов с ботом</div>
                    </div>
                    <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 text-center">
                      <div className="text-xl font-bold text-[#0f1c3f]">{activity.stats.sent_messages || 0}</div>
                      <div className="text-xs text-gray-500 mt-0.5">сообщений коллегам</div>
                    </div>
                    <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 text-center">
                      <div className="text-xl font-bold text-[#0f1c3f]">{activity.stats.files || 0}</div>
                      <div className="text-xs text-gray-500 mt-0.5">загруженных файлов</div>
                    </div>
                  </div>

                  <div className="text-sm font-bold text-[#0f1c3f]">
                    Журнал действий с персональными данными
                  </div>
                  {!activity.audit.length ? (
                    <p className="text-center text-gray-400 py-6 text-sm">
                      Нет записей о действиях с персональными данными
                    </p>
                  ) : (
                    <div className="overflow-x-auto border border-gray-100 rounded-xl">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wider border-b border-gray-100">
                            <th className="px-4 py-2.5 font-semibold">Время</th>
                            <th className="px-4 py-2.5 font-semibold">Действие</th>
                            <th className="px-4 py-2.5 font-semibold">Объект</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {activity.audit.map((r) => (
                            <tr key={r.id}>
                              <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                                {fmtDate(r.at)}
                              </td>
                              <td className="px-4 py-2.5 text-xs text-slate-700 font-medium">
                                {ACTION_LABEL[r.action] || r.action}
                              </td>
                              <td className="px-4 py-2.5 text-xs text-gray-500">
                                {r.entity || ''}
                                {r.entity_id ? ` #${r.entity_id}` : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </aside>
        </>
      )}
    </PageShell>
  );
}
