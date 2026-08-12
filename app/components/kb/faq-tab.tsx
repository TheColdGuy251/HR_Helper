'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileUp,
  GitBranch,
  HelpCircle,
  Link2,
  MessageSquare,
  Pencil,
  ToggleLeft,
  ToggleRight,
  Trash2,
  User,
  UserCog,
} from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiUpload, ApiError } from '@/lib/api';
import { EmptyState, ErrorCallout, InfoCallout, PrimaryButton, SearchInput, SecondaryButton } from '@/components/ui';
import GroupBlocks, { buildSections } from '@/components/kb/group-blocks';
import KbFilters, { type FilterDef } from '@/components/kb/filters-modal';

// Вкладка «FAQ» (только редакторы БЗ) — порт loadFaq/renderFaq/openFaqEditor/loadKbUsers из kb.js.

interface FaqEntry {
  id: number;
  group_key: string;
  position: number;
  source_file: string | null;
  block: string | null;
  variants: string[];
  clarify_question: string | null;
  option_label: string | null;
  answer: string;
  doc_refs: string[];
  contact: string | null;
  is_active: boolean;
}

interface KbUser {
  id: number;
  full_name: string;
  username: string;
  position: string | null;
  is_admin: boolean;
  is_kb_editor: boolean;
}

const inputCls =
  'w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-[#2563eb] text-sm text-slate-700';
const labelCls = 'text-xs font-bold text-gray-500 flex flex-col gap-1';

/** Тематика FAQ — из имени файла-источника («чат-бот Отпуска.docx» → «Отпуска»).
 *  Порт faqCategoryName из kb.js:1537. */
function faqCategoryName(sourceFile: string | null): string {
  let stem = String(sourceFile || '').replace(/\.[a-z0-9]+$/i, '');
  stem = stem.replace(/чат[\s-]?бот/i, '').replace(/^[\s\-–_]+|[\s\-–_]+$/g, '');
  return stem ? stem[0].toUpperCase() + stem.slice(1) : 'Прочее';
}

/** Ветвящаяся запись — есть метка под-ветки или уточняющий вопрос (kb.js:1515). */
const isBranch = (e: FaqEntry) => !!(e.option_label || e.clarify_question);

export default function FaqTab({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<FaqEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // Фильтры вкладки — в модалке «Фильтры» (kb.html:328-348).
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'progress'; text: string } | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await apiGet<{ items: FaqEntry[] }>('/api/kb/faq');
      setItems(data.items || []);
      setError('');
    } catch (e) {
      if (!silent) setError(e instanceof ApiError ? e.message : 'Не удалось загрузить FAQ.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    };
  }, [load]);

  const toggleEntry = async (e: FaqEntry) => {
    try {
      await apiPatch(`/api/kb/faq/${e.id}`, { is_active: !e.is_active });
      load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось изменить запись.');
    }
  };

  const deleteEntry = async (id: number) => {
    if (!window.confirm('Удалить FAQ-запись? Ответы бота перестанут её использовать.')) return;
    try {
      await apiDelete(`/api/kb/faq/${id}`);
      load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить запись.');
    }
  };

  const importFiles = async (files: File[]) => {
    if (!files.length) return;
    if (
      !window.confirm(
        `Импорт ${files.length} файл(ов) ЗАМЕНИТ все FAQ-записи, включая ручные правки. Продолжить?`
      )
    )
      return;
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus({ kind: 'progress', text: 'Импортирую…' });
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    try {
      const data = await apiUpload<{ groups?: number; entries?: number }>('/api/kb/faq/import', fd);
      setStatus({ kind: 'ok', text: `Импортировано: ${data.groups ?? 0} блоков, ${data.entries ?? 0} записей` });
      load(true);
    } catch (err) {
      setStatus({ kind: 'error', text: `Ошибка: ${err instanceof ApiError ? err.message : 'соединение прервано'}` });
    } finally {
      statusTimer.current = setTimeout(() => setStatus(null), 6000);
    }
  };

  // Фильтры — порт faqPredicate из kb.js:1548 + тематика + поиск.
  const q = search.trim().toLowerCase();
  const filtered = items.filter((e) => {
    if (filters.group && faqCategoryName(e.source_file) !== filters.group) return false;
    const st = filters.state || '';
    if (st && (st === 'on') !== e.is_active) return false;
    const tp = filters.type || '';
    if (tp === 'branch' && !isBranch(e)) return false;
    if (tp === 'simple' && isBranch(e)) return false;
    if (tp === 'contact' && !e.contact) return false;
    if (tp === 'docs' && !(e.doc_refs || []).length) return false;
    if (!q) return true;
    const hay = [e.block, e.answer, e.clarify_question, e.option_label, e.contact, ...(e.variants || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  // Опции «Тематика» строим по полному списку (kb.js:165 fillGroupFilter).
  const topics = [...new Set(items.map((e) => faqCategoryName(e.source_file)))].sort((a, b) =>
    a.localeCompare(b, 'ru'),
  );
  const filterDefs: FilterDef[] = [
    {
      key: 'group',
      label: 'Тематика',
      options: [{ value: '', label: 'Все группы' }, ...topics.map((t) => ({ value: t, label: t }))],
    },
    {
      key: 'state',
      label: 'Участие в ответах бота',
      options: [
        { value: '', label: 'Любое' },
        { value: 'on', label: 'Активные' },
        { value: 'off', label: 'Выключенные' },
      ],
    },
    {
      key: 'type',
      label: 'Тип записи',
      options: [
        { value: '', label: 'Любой' },
        { value: 'branch', label: 'Ветвящиеся (с уточнением)' },
        { value: 'simple', label: 'Простые' },
        { value: 'contact', label: 'С контактом' },
        { value: 'docs', label: 'Со ссылками на документы' },
      ],
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Панель действий */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <input
          type="file"
          ref={importRef}
          accept=".docx,.doc"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            importFiles(files);
          }}
        />
        <PrimaryButton
          onClick={() => importRef.current?.click()}
          title="Полный реимпорт из файлов «чат-бот …» (заменит все записи)"
        >
          <FileUp size={16} /> Импорт из файлов
        </PrimaryButton>
        <SearchInput value={search} onChange={setSearch} placeholder="Поиск по вопросам и ответам…" />
        <KbFilters
          defs={filterDefs}
          values={filters}
          onChange={(key, value) => setFilters((f) => ({ ...f, [key]: value }))}
          onReset={() => {
            setFilters({});
            setSearch('');
          }}
        />
      </div>

      <InfoCallout>
        Записи FAQ подмешиваются в ответы бота при совпадении формулировок; у ветвящихся блоков бот задаёт уточняющий
        вопрос. Контакт подразделения показывается в футере ответа. Импорт <b>заменяет</b> все записи, включая ручные
        правки.
      </InfoCallout>

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

      {error && <ErrorCallout>{error}</ErrorCallout>}

      {/* Доступы редакторов (только админ) */}
      {isAdmin && <EditorsAccess />}

      {/* Список FAQ: плитка групп по тематикам (kb.js:1568) */}
      {loading ? (
        <EmptyState>Загрузка…</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>
          {items.length === 0 ? 'FAQ пуст — импортируйте файлы «чат-бот …».' : 'Ничего не найдено.'}
        </EmptyState>
      ) : (
        <GroupBlocks
          sections={buildSections(
            filtered,
            (e) => {
              const name = faqCategoryName(e.source_file);
              return { key: name, name, icon: MessageSquare };
            },
            (e) => ({
              key: e.id,
              node: (
                <FaqCard
                  entry={e}
                  editing={editId === e.id}
                  onEdit={() => setEditId(editId === e.id ? null : e.id)}
                  onToggle={() => toggleEntry(e)}
                  onDelete={() => deleteEntry(e.id)}
                  onSaved={() => {
                    setEditId(null);
                    load(true);
                  }}
                />
              ),
            }),
            (a, b) => a.name.localeCompare(b.name, 'ru'),
          )}
        />
      )}
    </div>
  );
}

/** Карточка FAQ-записи с инлайн-редактором. */
function FaqCard({
  entry: e,
  editing,
  onEdit,
  onToggle,
  onDelete,
  onSaved,
}: {
  entry: FaqEntry;
  editing: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onSaved: () => void;
}) {
  const answerShort = (e.answer || '').length > 220 ? `${e.answer.slice(0, 220)}…` : e.answer || '';

  return (
    <div
      className={`bg-white border border-gray-100 rounded-xl p-2.5 shadow-sm flex flex-col gap-2 hover:border-gray-200 transition ${
        e.is_active ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center flex-shrink-0">
            <MessageSquare size={18} />
          </div>
          <div className="flex flex-col min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-sm text-[#0f1c3f]">{e.block || '(без блока)'}</span>
              {e.option_label && (
                <span className="inline-flex items-center gap-1 bg-violet-50 text-violet-600 text-[10px] font-bold px-2 py-0.5 rounded">
                  <GitBranch size={10} /> {e.option_label}
                </span>
              )}
              {e.source_file && (
                <span className="bg-gray-100 text-gray-500 text-[10px] font-bold px-2 py-0.5 rounded">
                  {e.source_file}
                </span>
              )}
            </div>
            {(e.variants || []).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {e.variants.map((v, i) => (
                  <span key={i} className="bg-gray-100 text-gray-500 text-[10px] font-semibold px-2 py-0.5 rounded">
                    {v}
                  </span>
                ))}
              </div>
            )}
            {e.clarify_question && (
              <div className="text-xs text-gray-500 flex items-center gap-1.5">
                <HelpCircle size={12} className="shrink-0" /> Уточняющий вопрос: {e.clarify_question}
              </div>
            )}
            <p className="text-xs text-slate-600 whitespace-pre-line">{answerShort}</p>
            {(e.doc_refs || []).length > 0 && (
              <div className="text-xs text-gray-400 flex items-center gap-1.5">
                <Link2 size={12} className="shrink-0" /> {e.doc_refs.join('; ')}
              </div>
            )}
            {e.contact && (
              <div className="text-xs text-gray-400 flex items-center gap-1.5">
                <User size={12} className="shrink-0" /> {e.contact}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 text-gray-400 flex-shrink-0">
          <button
            onClick={onEdit}
            className="p-2 hover:bg-gray-50 rounded-lg hover:text-slate-700 transition"
            title="Редактировать"
          >
            <Pencil size={16} />
          </button>
          <button
            onClick={onToggle}
            className={`p-2 rounded-lg transition ${
              e.is_active ? 'text-emerald-500 hover:bg-emerald-50' : 'hover:bg-gray-50 hover:text-slate-700'
            }`}
            title={e.is_active ? 'Выключить (не участвует в ответах)' : 'Включить'}
          >
            {e.is_active ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
          </button>
          <button
            onClick={onDelete}
            className="p-2 hover:bg-red-50 rounded-lg hover:text-red-600 transition"
            title="Удалить"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {editing && <FaqEditor entry={e} onCancel={onEdit} onSaved={onSaved} />}
    </div>
  );
}

/** Инлайн-редактор FAQ-записи (PATCH /api/kb/faq/{id}). */
function FaqEditor({ entry, onCancel, onSaved }: { entry: FaqEntry; onCancel: () => void; onSaved: () => void }) {
  const [variants, setVariants] = useState((entry.variants || []).join('\n'));
  const [clarify, setClarify] = useState(entry.clarify_question || '');
  const [optionLabel, setOptionLabel] = useState(entry.option_label || '');
  const [answer, setAnswer] = useState(entry.answer || '');
  const [contact, setContact] = useState(entry.contact || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setSaving(true);
    setErr('');
    try {
      await apiPatch(`/api/kb/faq/${entry.id}`, {
        variants: variants.split('\n').map((s) => s.trim()).filter(Boolean),
        clarify_question: clarify.trim(),
        option_label: optionLabel.trim(),
        answer,
        contact: contact.trim(),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Ошибка соединения');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-gray-100 pt-3 mt-1 flex flex-col gap-3">
      <label className={labelCls}>
        Варианты запросов (по одному в строке)
        <textarea value={variants} onChange={(e) => setVariants(e.target.value)} rows={3} className={inputCls} />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={labelCls}>
          Уточняющий вопрос (для ветвящихся блоков)
          <input type="text" value={clarify} onChange={(e) => setClarify(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Метка под-ветки
          <input type="text" value={optionLabel} onChange={(e) => setOptionLabel(e.target.value)} className={inputCls} />
        </label>
      </div>
      <label className={labelCls}>
        Ответ
        <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={6} className={inputCls} />
      </label>
      <label className={labelCls}>
        Контактное лицо / подразделение
        <input type="text" value={contact} onChange={(e) => setContact(e.target.value)} className={inputCls} />
      </label>
      {err && <ErrorCallout>{err}</ErrorCallout>}
      <div className="flex justify-end gap-3">
        <SecondaryButton onClick={onCancel}>Отмена</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </PrimaryButton>
      </div>
    </div>
  );
}

/** Блок «Доступы: редакторы базы знаний» (только админ). */
function EditorsAccess() {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<KbUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ items: KbUser[] }>('/api/kb/users');
      setUsers(data.items || []);
      setErr('');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Ошибка загрузки пользователей');
    } finally {
      setLoaded(true);
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded) load();
  };

  const setRole = async (u: KbUser, checked: boolean) => {
    // Оптимистичное обновление чекбокса, откат при ошибке.
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, is_kb_editor: checked } : x)));
    try {
      await apiPatch(`/api/kb/users/${u.id}/roles`, { is_kb_editor: checked });
    } catch {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, is_kb_editor: !checked } : x)));
      setErr('Не удалось изменить роль');
    }
  };

  return (
    <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 p-4 text-sm font-bold text-[#0f1c3f] hover:bg-gray-50 transition text-left"
      >
        <UserCog size={16} className="text-[#2563eb]" /> Доступы: редакторы базы знаний
        {open ? (
          <ChevronDown size={16} className="ml-auto text-gray-400" />
        ) : (
          <ChevronRight size={16} className="ml-auto text-gray-400" />
        )}
      </button>
      {open && (
        <div className="border-t border-gray-100 p-4 flex flex-col gap-2">
          {err && <ErrorCallout>{err}</ErrorCallout>}
          {!loaded ? (
            <p className="text-xs text-gray-400 text-center py-3">Загрузка…</p>
          ) : users.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-3">Пользователи не найдены</p>
          ) : (
            users.map((u) => (
              <div key={u.id} className="flex items-center gap-3 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2">
                <User size={16} className="text-blue-600 flex-shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-sm font-semibold text-slate-700 truncate">
                    {u.full_name}
                    {u.position ? <span className="text-gray-400 font-normal"> • {u.position}</span> : null}
                  </span>
                  <span className="text-[11px] text-gray-400">
                    @{u.username}
                    {u.is_admin ? ' • администратор' : ''}
                  </span>
                </div>
                <label className="flex items-center gap-2 text-xs font-bold text-gray-500 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={u.is_kb_editor || u.is_admin}
                    disabled={u.is_admin}
                    onChange={(e) => setRole(u, e.target.checked)}
                    className="w-4 h-4 accent-[#2563eb]"
                  />
                  редактор БЗ
                </label>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
