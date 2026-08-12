'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  FileUp,
  Lock,
  LogOut,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Unlock,
  UserPlus,
  X,
  Zap,
} from 'lucide-react';
import { apiGet, apiJson, apiPost, ApiError, formatBytes } from '@/lib/api';
import { useAuth } from '@/components/auth-context';
import { Card, EmptyState, ErrorCallout, InfoCallout, PrimaryButton, SearchInput, SecondaryButton } from '@/components/ui';

// Вкладка «Персональные данные» — порт PII-контура из kb.js + routes/pii.py.
// Доступ: can_access_pii + повторный ввод пароля (сессия 15 минут, cookie pii_token).

interface PiiPerson {
  id: number;
  surname: string;
  name: string;
  patronymic: string | null;
  birth_date: string | null;
  full_name: string;
  full_name_with_dob?: string;
  documents_count: number;
  created_at: string;
}

interface PiiDoc {
  id: number;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  note: string | null;
  uploaded_at: string;
}

interface PersonDetail extends PiiPerson {
  documents: PiiDoc[];
}

interface QuickData {
  filename: string;
  recognized: {
    surname: string | null;
    name: string | null;
    patronymic: string | null;
    birth_date: string | null;
  };
  candidates: PiiPerson[];
  /** Примечание из восстановленного черновика (в ответе API его нет). */
  note?: string;
  /** Черновик восстановлен: файл в браузере не хранится, его выбирают заново. */
  restored?: boolean;
}

// ── Черновик карточки при истечении сессии (kb.js:1062 saveDraftOnTimeout /
//    :1078 restoreDraftIfAny). Ключ и формат — те же, что в легаси. ──

const PII_DRAFT_KEY = 'hr_pii_draft_v1';

interface PiiQuickDraft {
  kind: 'quick';
  filename: string;
  surname: string;
  name: string;
  patronymic: string;
  birth_date: string;
  note: string;
}

/** Чтение черновика с проверкой формата (localStorage может содержать что угодно). */
function readQuickDraft(): PiiQuickDraft | null {
  try {
    const raw = localStorage.getItem(PII_DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (o.kind !== 'quick') return null;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      kind: 'quick',
      filename: str(o.filename),
      surname: str(o.surname),
      name: str(o.name),
      patronymic: str(o.patronymic),
      birth_date: str(o.birth_date),
      note: str(o.note),
    };
  } catch {
    return null;
  }
}

function dropQuickDraft() {
  try {
    localStorage.removeItem(PII_DRAFT_KEY);
  } catch {
    /* приватный режим — ничего страшного */
  }
}

const inputCls =
  'w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-[#2563eb] text-sm text-slate-700';
const labelCls = 'text-xs font-bold text-gray-500 flex flex-col gap-1';

/** multipart-загрузка без редиректа на /login: 401 тут означает истёкший PII-токен. */
async function piiUpload<T>(url: string, form: FormData): Promise<T> {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: form });
  if (!res.ok) {
    let detail = `Ошибка сервера (${res.status})`;
    try {
      const d = await res.json();
      if (typeof d?.detail === 'string') detail = d.detail;
    } catch {
      /* тело не JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

function Modal({ title, subtitle, onClose, children, danger = false }: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-lg p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className={`text-lg font-bold ${danger ? 'text-red-600' : 'text-[#0f1c3f]'}`}>{title}</h3>
            {subtitle && <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:bg-gray-50 hover:text-slate-700 transition"
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Обратный отсчёт MM:SS до конца PII-сессии. */
function Countdown({ expiresAt, onExpire }: { expiresAt: number; onExpire: () => void }) {
  const [remain, setRemain] = useState(() => Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)));
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    const t = setInterval(() => {
      const r = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setRemain(r);
      if (r <= 0) {
        clearInterval(t);
        expireRef.current();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  const mm = String(Math.floor(remain / 60)).padStart(2, '0');
  const ss = String(remain % 60).padStart(2, '0');
  return <span className="font-mono font-bold">{mm}:{ss}</span>;
}

export default function PiiTab() {
  const { user, loading: authLoading } = useAuth();
  const [phase, setPhase] = useState<'checking' | 'locked' | 'active'>('checking');
  const [lockMsg, setLockMsg] = useState('');
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [expiresAt, setExpiresAt] = useState(0);

  const [persons, setPersons] = useState<PiiPerson[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'progress'; text: string } | null>(null);
  const [error, setError] = useState('');

  const [showNewPerson, setShowNewPerson] = useState(false);
  const [quick, setQuick] = useState<QuickData | null>(null);
  const [deletePerson, setDeletePerson] = useState<PersonDetail | null>(null);
  const [draft, setDraft] = useState<PiiQuickDraft | null>(null);

  const quickFileRef = useRef<HTMLInputElement>(null);
  const import1cRef = useRef<HTMLInputElement>(null);
  const pendingQuickFile = useRef<File | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Живое содержимое модалки быстрой загрузки — чтобы успеть сохранить его до сброса.
  const quickDraftRef = useRef<PiiQuickDraft | null>(null);

  const onQuickFields = useCallback((d: PiiQuickDraft | null) => {
    quickDraftRef.current = d;
  }, []);

  /** Сохранить заполненную карточку в localStorage. true — если было что сохранять. */
  const saveQuickDraft = useCallback((): boolean => {
    const d = quickDraftRef.current;
    if (!d) return false;
    if (![d.surname, d.name, d.patronymic, d.birth_date, d.note].some((v) => v.trim())) return false;
    try {
      localStorage.setItem(PII_DRAFT_KEY, JSON.stringify(d));
      return true;
    } catch {
      return false; // приватный режим / нет места
    }
  }, []);

  /** Блокировка раздела. Истечение сессии сохраняет черновик, ручная — нет. */
  const lock = useCallback(
    (msg = '', opts?: { saveDraft?: boolean }) => {
      const saved = opts?.saveDraft === false ? false : saveQuickDraft();
      setPhase('locked');
      setLockMsg(
        saved
          ? `${msg} Заполненная карточка сохранена — после входа предложим её восстановить.`.trim()
          : msg
      );
      setPersons([]);
      setOpenId(null);
      setDetail(null);
      setQuick(null);
      setDeletePerson(null);
      setShowNewPerson(false);
      setStatus(null);
    },
    [saveQuickDraft]
  );

  /** Оборачивает вызов API: 401/403 → блокируем раздел. */
  const guard = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          lock('Сессия доступа к ПДн истекла — введите пароль заново.');
          return null;
        }
        throw e;
      }
    },
    [lock]
  );

  const loadPersons = useCallback(
    async (q: string) => {
      setListLoading(true);
      try {
        const url = q.trim() ? `/api/pii/persons?q=${encodeURIComponent(q.trim())}` : '/api/pii/persons';
        const data = await guard(() => apiGet<{ items: PiiPerson[] }>(url, { skipAuthRedirect: true }));
        if (data) {
          setPersons(data.items || []);
          setError('');
        }
      } catch {
        setError('Не удалось загрузить список сотрудников.');
      } finally {
        setListLoading(false);
      }
    },
    [guard]
  );

  // Первичная проверка состояния PII-сессии.
  useEffect(() => {
    if (authLoading || !user?.can_access_pii) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ can_access: boolean; active: boolean; remaining_seconds: number }>(
          '/api/pii/session'
        );
        if (cancelled) return;
        if (data.active && data.remaining_seconds > 0) {
          setExpiresAt(Date.now() + data.remaining_seconds * 1000);
          setPhase('active');
        } else {
          setPhase('locked');
        }
      } catch {
        if (!cancelled) setPhase('locked');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user]);

  // При активации — загружаем карточки и проверяем черновик (restoreDraftIfAny).
  useEffect(() => {
    if (phase === 'active') {
      loadPersons('');
      setDraft(readQuickDraft());
    }
  }, [phase, loadPersons]);

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    []
  );

  const flashStatus = (kind: 'ok' | 'error', text: string, ms = 5000) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus({ kind, text });
    if (kind === 'ok') statusTimer.current = setTimeout(() => setStatus(null), ms);
  };

  const reauth = async (e: React.FormEvent) => {
    e.preventDefault();
    setUnlocking(true);
    setLockMsg('');
    try {
      const data = await apiPost<{ success: boolean; expires_in: number }>(
        '/api/pii/reauth',
        { password },
        { skipAuthRedirect: true }
      );
      setPassword('');
      setExpiresAt(Date.now() + (data.expires_in || 15 * 60) * 1000);
      setPhase('active');
    } catch (err) {
      setLockMsg(err instanceof ApiError ? err.message : 'Ошибка соединения');
    } finally {
      setUnlocking(false);
    }
  };

  const logout = async () => {
    try {
      await apiPost('/api/pii/reauth/logout', undefined, { skipAuthRedirect: true });
    } catch {
      /* блокируем в любом случае */
    }
    lock('', { saveDraft: false }); // ручная блокировка — черновик не копим
  };

  /** Открыть модалку с восстановленным черновиком (файл выбирается заново). */
  const restoreDraft = () => {
    if (!draft) return;
    pendingQuickFile.current = null;
    setQuick({
      filename: draft.filename,
      recognized: {
        surname: draft.surname,
        name: draft.name,
        patronymic: draft.patronymic,
        birth_date: draft.birth_date,
      },
      candidates: [],
      note: draft.note,
      restored: true,
    });
    dropQuickDraft();
    setDraft(null);
  };

  const onSearchChange = (v: string) => {
    setSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => loadPersons(v), 250);
  };

  const openPerson = async (id: number) => {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await guard(() => apiGet<{ person: PersonDetail }>(`/api/pii/persons/${id}`, { skipAuthRedirect: true }));
      if (data) setDetail(data.person);
    } catch {
      setError('Не удалось загрузить карточку.');
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async (id: number) => {
    const data = await guard(() => apiGet<{ person: PersonDetail }>(`/api/pii/persons/${id}`, { skipAuthRedirect: true }));
    if (data) setDetail(data.person);
    loadPersons(search);
  };

  const quickAnalyze = async (file: File) => {
    setStatus({ kind: 'progress', text: `Распознавание «${file.name}»…` });
    const form = new FormData();
    form.append('file', file);
    try {
      const data = await guard(() => piiUpload<QuickData & { success: boolean }>('/api/pii/upload/quick-analyze', form));
      if (!data) return;
      setStatus(null);
      pendingQuickFile.current = file;
      setQuick(data);
    } catch (err) {
      flashStatus('error', `Ошибка: ${err instanceof ApiError ? err.message : 'соединение прервано'}`);
    }
  };

  const import1c = async (file: File) => {
    setStatus({ kind: 'progress', text: `Импорт сотрудников из «${file.name}»…` });
    const form = new FormData();
    form.append('file', file);
    try {
      const data = await guard(() => piiUpload<{ created: number; skipped: number }>('/api/pii/import/1c', form));
      if (!data) return;
      flashStatus('ok', `Добавлено сотрудников: ${data.created}, пропущено (дубли/без ФИО): ${data.skipped}.`);
      loadPersons(search);
    } catch (err) {
      flashStatus('error', `Ошибка: ${err instanceof ApiError ? err.message : 'соединение прервано'}`);
    }
  };

  const uploadDirect = async (personId: number, file: File, note: string) => {
    const form = new FormData();
    form.append('file', file);
    if (note.trim()) form.append('note', note.trim());
    try {
      const data = await guard(() => piiUpload(`/api/pii/persons/${personId}/documents`, form));
      if (data) refreshDetail(personId);
    } catch (err) {
      flashStatus('error', `Ошибка: ${err instanceof ApiError ? err.message : 'соединение прервано'}`);
    }
  };

  const deleteDoc = async (docId: number, personId: number) => {
    if (!window.confirm('Удалить документ?')) return;
    try {
      const res = await guard(() => apiJson('DELETE', `/api/pii/documents/${docId}`, undefined, { skipAuthRedirect: true }));
      if (res !== null) refreshDetail(personId);
    } catch (err) {
      flashStatus('error', `Ошибка: ${err instanceof ApiError ? err.message : 'не удалось удалить'}`);
    }
  };

  // --- Рендер по фазам ---

  if (authLoading) return <EmptyState>Загрузка…</EmptyState>;

  if (!user?.can_access_pii) {
    return (
      <InfoCallout>
        У вашей учётной записи нет доступа к разделу персональных данных. Обратитесь к администратору.
      </InfoCallout>
    );
  }

  if (phase === 'checking') return <EmptyState>Проверка доступа…</EmptyState>;

  // ФИО из черновика — для подписи в плашке восстановления.
  const draftFio = draft ? [draft.surname, draft.name, draft.patronymic].filter(Boolean).join(' ').trim() : '';

  if (phase === 'locked') {
    return (
      <Card className="max-w-md mx-auto w-full text-center flex flex-col items-center gap-4">
        <div className="w-12 h-12 bg-blue-50 text-[#2563eb] rounded-2xl flex items-center justify-center">
          <Lock size={22} />
        </div>
        <div>
          <h3 className="font-bold text-[#0f1c3f]">Раздел защищён</h3>
          <p className="text-xs text-gray-500 mt-1">
            Для доступа к персональным данным сотрудников введите пароль вашей учётной записи. Доступ сохраняется на 15
            минут.
          </p>
        </div>
        <form onSubmit={reauth} className="w-full flex flex-col gap-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Ваш пароль"
            required
            className={inputCls}
          />
          <PrimaryButton type="submit" disabled={unlocking}>
            <Unlock size={16} /> {unlocking ? 'Проверка…' : 'Открыть'}
          </PrimaryButton>
        </form>
        {lockMsg && <ErrorCallout>{lockMsg}</ErrorCallout>}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Баннер защищённого раздела */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-sm text-blue-800">
        <div className="flex items-center gap-2 font-medium">
          <ShieldCheck size={18} className="shrink-0" />
          <span>
            <b>Защищённый раздел.</b> Сессия активна{' '}
            <Countdown
              expiresAt={expiresAt}
              onExpire={() => lock('Время сессии истекло — введите пароль для продолжения.')}
            />
            .
          </span>
        </div>
        <SecondaryButton onClick={logout} className="!py-2">
          <LogOut size={14} /> Заблокировать
        </SecondaryButton>
      </div>

      {/* Действия */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <input
          type="file"
          ref={quickFileRef}
          accept=".pdf,.docx,.doc,.txt,.md,.jpg,.jpeg,.png"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) quickAnalyze(f);
          }}
        />
        <input
          type="file"
          ref={import1cRef}
          accept=".csv,.xlsx,.xls,.ods"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) import1c(f);
          }}
        />
        <PrimaryButton onClick={() => quickFileRef.current?.click()}>
          <Zap size={16} /> Быстрая загрузка
        </PrimaryButton>
        <SecondaryButton onClick={() => setShowNewPerson(true)}>
          <UserPlus size={16} /> Создать карточку
        </SecondaryButton>
        <SecondaryButton onClick={() => import1cRef.current?.click()} title="Импорт сотрудников из таблицы 1С (CSV/XLSX)">
          <FileUp size={16} /> Импорт из 1С
        </SecondaryButton>
        <SearchInput value={search} onChange={onSearchChange} placeholder="Поиск по ФИО…" />
      </div>

      {status && (
        <div
          className={`rounded-xl border p-3 text-xs font-semibold ${
            status.kind === 'error'
              ? 'bg-red-50 border-red-100 text-red-600'
              : status.kind === 'ok'
                ? 'bg-emerald-50 border-emerald-100 text-emerald-700'
                : 'bg-blue-50 border-blue-100 text-blue-800'
          }`}
        >
          {status.text}
        </div>
      )}

      {/* Черновик карточки, сохранённый при истечении сессии */}
      {draft && !quick && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 text-xs text-amber-800">
          <RotateCcw size={16} className="shrink-0" />
          <p className="flex-1 font-medium">
            <b>Есть незавершённая карточка</b>
            {draftFio ? `: ${draftFio}` : ''}
            {draft.filename ? ` (файл «${draft.filename}»)` : ''} — сохранена, когда истекла сессия. Сам файл в
            браузере не хранится, его нужно выбрать заново.
          </p>
          <div className="flex gap-2 shrink-0">
            <PrimaryButton className="!py-2" onClick={restoreDraft}>
              Восстановить
            </PrimaryButton>
            <SecondaryButton
              className="!py-2"
              onClick={() => {
                dropQuickDraft();
                setDraft(null);
              }}
            >
              Удалить
            </SecondaryButton>
          </div>
        </div>
      )}

      {error && <ErrorCallout>{error}</ErrorCallout>}

      {/* Список карточек */}
      {listLoading ? (
        <EmptyState>Загрузка…</EmptyState>
      ) : persons.length === 0 ? (
        <EmptyState>Сотрудники не найдены. Создайте карточку или загрузите документ.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {persons.map((p) => {
            const open = openId === p.id;
            const initials = `${(p.surname || '').slice(0, 1)}${(p.name || '').slice(0, 1)}`.toUpperCase();
            return (
              <div key={p.id} className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
                <button
                  onClick={() => openPerson(p.id)}
                  className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 transition"
                >
                  <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0">
                    {initials}
                  </div>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="font-bold text-sm text-[#0f1c3f] truncate">
                      {p.full_name_with_dob || p.full_name}
                    </span>
                    <span className="text-xs text-gray-400">
                      {p.documents_count} документ(ов)
                      {p.birth_date ? ` • д.р. ${new Date(p.birth_date).toLocaleDateString('ru-RU')}` : ''}
                    </span>
                  </div>
                  {open ? (
                    <ChevronDown size={16} className="text-gray-400 flex-shrink-0" />
                  ) : (
                    <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />
                  )}
                </button>

                {open && (
                  <div className="border-t border-gray-100 p-4 flex flex-col gap-2">
                    {detailLoading || !detail ? (
                      <p className="text-xs text-gray-400 text-center py-4">Загрузка…</p>
                    ) : (
                      <PersonBody
                        person={detail}
                        onUpload={(file, note) => uploadDirect(p.id, file, note)}
                        onDeleteDoc={(docId) => deleteDoc(docId, p.id)}
                        onDeletePerson={() => setDeletePerson(detail)}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Модалки */}
      {showNewPerson && (
        <NewPersonModal
          onClose={() => setShowNewPerson(false)}
          onCreate={async (body) => {
            const data = await guard(() => apiPost('/api/pii/persons', body, { skipAuthRedirect: true }));
            if (data) {
              setShowNewPerson(false);
              loadPersons('');
              setSearch('');
            }
          }}
        />
      )}

      {quick && (
        <QuickConfirmModal
          data={quick}
          onFieldsChange={onQuickFields}
          onPickFile={(f) => {
            pendingQuickFile.current = f;
          }}
          onClose={() => {
            setQuick(null);
            pendingQuickFile.current = null;
          }}
          onSubmit={async (fields, personId) => {
            const file = pendingQuickFile.current;
            if (!file) {
              flashStatus('error', 'Файл утрачен — выберите файл заново.');
              setQuick(null);
              return;
            }
            const form = new FormData();
            form.append('file', file);
            if (personId) {
              form.append('person_id', String(personId));
            } else {
              form.append('surname', fields.surname);
              form.append('name', fields.name);
              if (fields.patronymic) form.append('patronymic', fields.patronymic);
              if (fields.birth_date) form.append('birth_date', fields.birth_date);
            }
            if (fields.note) form.append('note', fields.note);
            try {
              const data = await guard(() => piiUpload('/api/pii/upload/commit', form));
              if (data) {
                setQuick(null);
                pendingQuickFile.current = null;
                flashStatus('ok', 'Документ сохранён.');
                loadPersons(search);
              }
            } catch (err) {
              flashStatus('error', `Ошибка: ${err instanceof ApiError ? err.message : 'соединение прервано'}`);
            }
          }}
        />
      )}

      {deletePerson && (
        <DeletePersonModal
          person={deletePerson}
          onClose={() => setDeletePerson(null)}
          onDelete={async () => {
            try {
              const res = await guard(() =>
                apiJson('DELETE', `/api/pii/persons/${deletePerson.id}`, undefined, { skipAuthRedirect: true })
              );
              if (res !== null) {
                setDeletePerson(null);
                setOpenId(null);
                setDetail(null);
                loadPersons(search);
              }
            } catch (err) {
              flashStatus('error', `Не удалось удалить: ${err instanceof ApiError ? err.message : 'ошибка'}`);
            }
          }}
        />
      )}
    </div>
  );
}

/** Раскрытая карточка: документы + загрузка + удаление карточки. */
function PersonBody({
  person,
  onUpload,
  onDeleteDoc,
  onDeletePerson,
}: {
  person: PersonDetail;
  onUpload: (file: File, note: string) => void;
  onDeleteDoc: (docId: number) => void;
  onDeletePerson: () => void;
}) {
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const docs = person.documents || [];

  return (
    <>
      {docs.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-3">Документов пока нет</p>
      ) : (
        docs.map((d) => (
          <div key={d.id} className="flex items-center gap-3 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2">
            <FileText size={16} className="text-blue-600 flex-shrink-0" />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-sm font-semibold text-slate-700 truncate">{d.filename}</span>
              <span className="text-[11px] text-gray-400 truncate">
                {formatBytes(d.size_bytes)}
                {d.note ? ` • ${d.note}` : ''} • {new Date(d.uploaded_at).toLocaleString('ru-RU')}
              </span>
            </div>
            <a
              href={`/api/pii/documents/${d.id}/download`}
              className="p-2 text-gray-400 hover:bg-white rounded-lg hover:text-slate-700 transition inline-flex"
              title="Скачать"
            >
              <Download size={15} />
            </a>
            <button
              onClick={() => onDeleteDoc(d.id)}
              className="p-2 text-gray-400 hover:bg-red-50 rounded-lg hover:text-red-600 transition"
              title="Удалить"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-2 border-t border-gray-100 mt-1">
        <input
          type="file"
          ref={fileRef}
          accept=".pdf,.docx,.doc,.txt,.md,.jpg,.jpeg,.png"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) {
              onUpload(f, note);
              setNote('');
            }
          }}
        />
        <SecondaryButton onClick={() => fileRef.current?.click()} className="!py-2">
          <Plus size={14} /> Добавить документ
        </SecondaryButton>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Комментарий к документу (необязательно)"
          className={`${inputCls} !py-2 flex-1`}
        />
        <button
          onClick={onDeletePerson}
          className="text-xs font-bold text-red-500 hover:text-red-700 transition inline-flex items-center gap-1.5 justify-center px-3 py-2"
          title="Удалить карточку и все её документы"
        >
          <Trash2 size={14} /> Удалить карточку
        </button>
      </div>
    </>
  );
}

/** Модалка «Новая карточка сотрудника» (POST /api/pii/persons). */
function NewPersonModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (body: { surname: string; name: string; patronymic: string | null; birth_date: string | null }) => Promise<void>;
}) {
  const [surname, setSurname] = useState('');
  const [name, setName] = useState('');
  const [patronymic, setPatronymic] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!surname.trim() || !name.trim()) {
      setErr('Фамилия и имя обязательны');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await onCreate({
        surname: surname.trim(),
        name: name.trim(),
        patronymic: patronymic.trim() || null,
        birth_date: birthDate.trim() || null,
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Ошибка соединения');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Новая карточка сотрудника" onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className={labelCls}>
          Фамилия*
          <input type="text" value={surname} onChange={(e) => setSurname(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Имя*
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Отчество
          <input type="text" value={patronymic} onChange={(e) => setPatronymic(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Дата рождения
          <input
            type="text"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            placeholder="DD.MM.YYYY"
            className={inputCls}
          />
        </label>
      </div>
      {err && <ErrorCallout>{err}</ErrorCallout>}
      <div className="flex justify-end gap-3">
        <SecondaryButton onClick={onClose}>Отмена</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving}>
          <UserPlus size={16} /> {saving ? 'Создание…' : 'Создать'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

/** Модалка подтверждения распознавания при быстрой загрузке. */
function QuickConfirmModal({
  data,
  onClose,
  onSubmit,
  onFieldsChange,
  onPickFile,
}: {
  data: QuickData;
  onClose: () => void;
  onSubmit: (
    fields: { surname: string; name: string; patronymic: string; birth_date: string; note: string },
    personId: number | null
  ) => Promise<void>;
  /** Сообщает наверх текущее содержимое — оно уйдёт в черновик при истечении сессии. */
  onFieldsChange: (draft: PiiQuickDraft | null) => void;
  /** Файл, выбранный заново после восстановления черновика. */
  onPickFile: (file: File) => void;
}) {
  const r = data.recognized || { surname: '', name: '', patronymic: '', birth_date: null };
  const [surname, setSurname] = useState(r.surname || '');
  const [name, setName] = useState(r.name || '');
  const [patronymic, setPatronymic] = useState(r.patronymic || '');
  const [birthDate, setBirthDate] = useState(() => {
    if (!r.birth_date) return '';
    // В черновике дата уже в виде ДД.ММ.ГГГГ — повторно не форматируем.
    return data.restored ? r.birth_date : new Date(r.birth_date).toLocaleDateString('ru-RU');
  });
  const [note, setNote] = useState(data.note || '');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const needsFile = !!data.restored && !picked;

  // Отдаём наверх актуальные поля; при закрытии модалки черновик больше не нужен.
  useEffect(() => {
    onFieldsChange({
      kind: 'quick',
      filename: data.filename,
      surname,
      name,
      patronymic,
      birth_date: birthDate,
      note,
    });
  }, [data.filename, surname, name, patronymic, birthDate, note, onFieldsChange]);

  useEffect(() => () => onFieldsChange(null), [onFieldsChange]);

  const submit = async (personId: number | null) => {
    if (needsFile) {
      setErr('Выберите файл документа — в браузере он не сохраняется.');
      return;
    }
    if (!personId && (!surname.trim() || !name.trim())) {
      setErr('Фамилия и имя обязательны');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await onSubmit(
        {
          surname: surname.trim(),
          name: name.trim(),
          patronymic: patronymic.trim(),
          birth_date: birthDate.trim(),
          note: note.trim(),
        },
        personId
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Распознавание сотрудника"
      subtitle={data.restored ? `${data.filename} (восстановлено)` : data.filename}
      onClose={onClose}
    >
      {data.restored && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 flex flex-col gap-2">
          <p className="text-xs font-bold text-amber-700">
            Черновик восстановлен. Файл в браузере не сохраняется — выберите документ заново.
          </p>
          <div className="flex items-center gap-3">
            <input
              type="file"
              ref={fileRef}
              accept=".pdf,.docx,.doc,.txt,.md,.jpg,.jpeg,.png"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) {
                  setPicked(f);
                  onPickFile(f);
                  setErr('');
                }
              }}
            />
            <SecondaryButton className="!py-2" onClick={() => fileRef.current?.click()}>
              <FileUp size={14} /> Выбрать файл
            </SecondaryButton>
            <span className="text-xs text-slate-600 truncate">
              {picked ? picked.name : 'файл не выбран'}
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className={labelCls}>
          Фамилия*
          <input type="text" value={surname} onChange={(e) => setSurname(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Имя*
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Отчество
          <input type="text" value={patronymic} onChange={(e) => setPatronymic(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Дата рождения
          <input
            type="text"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            placeholder="DD.MM.YYYY"
            className={inputCls}
          />
        </label>
      </div>

      {data.candidates.length > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 flex flex-col gap-2">
          <p className="text-xs font-bold text-amber-700">Похожие карточки уже есть в базе:</p>
          {data.candidates.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 bg-white rounded-lg px-3 py-2">
              <span className="text-xs font-semibold text-slate-700 truncate">
                {c.full_name_with_dob || c.full_name} • {c.documents_count} док.
              </span>
              <button
                onClick={() => submit(c.id)}
                disabled={saving || needsFile}
                className="text-[11px] font-bold text-[#2563eb] hover:text-[#1e40af] transition whitespace-nowrap disabled:opacity-60"
              >
                Загрузить в эту карточку
              </button>
            </div>
          ))}
        </div>
      )}

      <label className={labelCls}>
        Комментарий (тип документа, № и т.д.)
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={inputCls} />
      </label>

      {err && <ErrorCallout>{err}</ErrorCallout>}
      <div className="flex justify-end gap-3">
        <SecondaryButton onClick={onClose}>Отмена</SecondaryButton>
        <PrimaryButton onClick={() => submit(null)} disabled={saving || needsFile}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

/** Модалка удаления карточки: подтверждение вводом полного ФИО. */
function DeletePersonModal({
  person,
  onClose,
  onDelete,
}: {
  person: PersonDetail;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const expected = (person.full_name || `${person.surname} ${person.name} ${person.patronymic || ''}`).trim();
  const docsCount = (person.documents && person.documents.length) || person.documents_count || 0;
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const matches = normalize(confirmText) === normalize(expected);

  const submit = async () => {
    if (!matches) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      title="Удаление карточки сотрудника"
      danger
      onClose={onClose}
      subtitle={
        <span>
          Будут <b>безвозвратно удалены</b> карточка <b className="text-red-600">{expected}</b> и все её документы (
          {docsCount} шт.). Зашифрованные файлы будут стёрты с диска.
        </span>
      }
    >
      <div className="flex items-center gap-2 text-xs font-bold text-red-600 bg-red-50 border border-red-100 rounded-xl p-3">
        <AlertTriangle size={16} className="shrink-0" />
        Чтобы подтвердить, введите ФИО сотрудника полностью.
      </div>
      <label className={labelCls}>
        ФИО для подтверждения
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="Введите ФИО точно как показано выше"
          autoComplete="off"
          spellCheck={false}
          className={inputCls}
        />
        <span className={`text-[11px] font-medium ${matches ? 'text-emerald-600' : 'text-gray-400'}`}>
          {matches ? 'Совпадает — можно подтверждать' : 'Кнопка активируется при совпадении'}
        </span>
      </label>
      <div className="flex justify-end gap-3">
        <SecondaryButton onClick={onClose}>Отмена</SecondaryButton>
        <button
          onClick={submit}
          disabled={!matches || deleting}
          className="bg-red-600 text-white px-5 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 hover:bg-red-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trash2 size={16} /> {deleting ? 'Удаление…' : 'Удалить навсегда'}
        </button>
      </div>
    </Modal>
  );
}
