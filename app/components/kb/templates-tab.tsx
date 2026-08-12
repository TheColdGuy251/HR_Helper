'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Eye, FileText, Pencil, Plus, Star, Trash2, Upload, X } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost, apiUpload, ApiError } from '@/lib/api';
import { Card, EmptyState, ErrorCallout, PrimaryButton, SearchInput, SecondaryButton } from '@/components/ui';
import GroupBlocks, { buildSections } from '@/components/kb/group-blocks';
import KbFilters, { type FilterDef } from '@/components/kb/filters-modal';

// Вкладка «Шаблоны» — порт loadCategories/loadTemplates/renderTemplates из kb.js.

interface TplCategory {
  id: number;
  slug: string;
  name: string;
  icon: string | null;
  sort_order: number;
  default_template_id: number | null;
}

interface TplField {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  hint?: string | null;
}

interface KbTemplate {
  id: number;
  key: string;
  title: string;
  description: string | null;
  is_enabled: boolean;
  category_id: number | null;
  fields_count: number;
  fields: TplField[];
  created_at: string;
}

const inputCls =
  'w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-[#2563eb] text-sm text-slate-700';
const labelCls = 'text-xs font-bold text-gray-500 flex flex-col gap-1';

function Modal({ title, subtitle, onClose, children }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-lg p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-[#0f1c3f]">{title}</h3>
            {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
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

export default function TemplatesTab({ canEdit }: { canEdit: boolean }) {
  const [categories, setCategories] = useState<TplCategory[]>([]);
  const [items, setItems] = useState<KbTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // Фильтры вкладки — в модалке «Фильтры» (kb.html:312-326).
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'progress'; text: string } | null>(null);
  const [editTpl, setEditTpl] = useState<KbTemplate | null>(null);
  const [openFields, setOpenFields] = useState<number | null>(null);

  // Форма загрузки
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [cats, tpls] = await Promise.all([
        apiGet<{ items: TplCategory[] }>('/api/kb/template-categories'),
        apiGet<{ items: KbTemplate[] }>('/api/kb/templates'),
      ]);
      setCategories(cats.items || []);
      setItems(tpls.items || []);
      setError('');
    } catch {
      if (!silent) setError('Не удалось загрузить шаблоны.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (hideRef.current) clearTimeout(hideRef.current);
    };
  }, [load]);

  const uploadTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setStatus({ kind: 'error', text: 'Выберите файл .docx, .doc или .pdf' });
      return;
    }
    if (!title.trim()) {
      setStatus({ kind: 'error', text: 'Введите название' });
      return;
    }
    if (hideRef.current) clearTimeout(hideRef.current);
    setStatus({ kind: 'progress', text: `Разбор шаблона «${file.name}»…` });
    const form = new FormData();
    form.append('file', file);
    form.append('title', title.trim());
    if (description.trim()) form.append('description', description.trim());
    if (categoryId) form.append('category_id', categoryId);
    try {
      const data = await apiUpload<{ template: { fields_count: number } }>('/api/kb/templates', form);
      setStatus({ kind: 'ok', text: `Шаблон добавлен, полей: ${data.template.fields_count}.` });
      setTitle('');
      setDescription('');
      setCategoryId('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      load(true);
      hideRef.current = setTimeout(() => setStatus(null), 3500);
    } catch (err) {
      setStatus({ kind: 'error', text: `Ошибка: ${err instanceof ApiError ? err.message : 'соединение прервано'}` });
    }
  };

  const deleteTemplate = async (id: number) => {
    if (!window.confirm('Удалить шаблон?')) return;
    try {
      await apiDelete(`/api/kb/templates/${id}`);
      load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить шаблон.');
    }
  };

  const toggleDefault = async (tpl: KbTemplate, isDefault: boolean) => {
    if (!tpl.category_id) return;
    try {
      await apiPost(`/api/kb/template-categories/${tpl.category_id}/default`, {
        template_id: isDefault ? null : tpl.id,
      });
      load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось изменить шаблон по умолчанию.');
    }
  };

  const catById = new Map(categories.map((c) => [c.id, c]));
  const isDefaultTpl = (t: KbTemplate) => {
    const cat = t.category_id ? catById.get(t.category_id) : undefined;
    return !!cat && cat.default_template_id === t.id;
  };
  // Группа шаблона — категория (kb.js:905), «Без категории» отдельным блоком.
  const tplGroupOf = (t: KbTemplate) => {
    const cat = t.category_id ? catById.get(t.category_id) : undefined;
    return cat ? { key: String(cat.id), name: cat.name } : { key: 'none', name: 'Без категории' };
  };
  // Порядок групп: как в списке категорий, «Без категории» — в конце.
  const catOrder = new Map(categories.map((c, i) => [String(c.id), i]));

  // Фильтры — порт tplPredicate из kb.js:833 + группа + поиск.
  const q = search.trim().toLowerCase();
  const filtered = items.filter((t) => {
    if (filters.group && tplGroupOf(t).key !== filters.group) return false;
    if (q && !`${t.title} ${t.description || ''}`.toLowerCase().includes(q)) return false;
    const k = filters.kind || '';
    if (k === 'fillable') return (t.fields_count || 0) > 0;
    if (k === 'reference') return (t.fields_count || 0) === 0;
    if (k === 'default') return isDefaultTpl(t);
    return true;
  });

  const filterDefs: FilterDef[] = [
    {
      key: 'group',
      label: 'Категория',
      options: [
        { value: '', label: 'Все группы' },
        ...categories.map((c) => ({ value: String(c.id), label: c.name })),
        { value: 'none', label: 'Без категории' },
      ],
    },
    {
      key: 'kind',
      label: 'Тип шаблона',
      options: [
        { value: '', label: 'Любой' },
        { value: 'fillable', label: 'С полями формы' },
        { value: 'reference', label: 'Справочные (без полей)' },
        { value: 'default', label: 'По умолчанию в категории' },
      ],
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Форма добавления шаблона */}
      {canEdit && (
        <Card>
          <form onSubmit={uploadTemplate} className="flex flex-col gap-3">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Название шаблона"
              required
              className={inputCls}
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Описание (необязательно)"
              className={inputCls}
            />
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputCls}>
              <option value="">— выберите категорию —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="file"
                ref={fileRef}
                accept=".docx,.doc,.pdf"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              <SecondaryButton type="button" onClick={() => fileRef.current?.click()}>
                <Upload size={16} /> {file ? file.name : 'Выбрать .docx / .doc / .pdf'}
              </SecondaryButton>
              <PrimaryButton type="submit" className="sm:ml-auto">
                <Plus size={16} /> Добавить шаблон
              </PrimaryButton>
            </div>
            <p className="text-[11px] text-gray-400">
              {'Плейсхолдеры {{ фамилия }}, {{ должность }} станут полями формы. Если их нет — поля определятся автоматически по пропускам «____» в бланке. .doc конвертируется в .docx, .pdf — справочный (только просмотр/скачивание).'}
            </p>
          </form>
        </Card>
      )}

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

      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Поиск по шаблонам…" />
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

      {error && <ErrorCallout>{error}</ErrorCallout>}

      {/* Плитка групп по категориям (kb.js:905) */}
      {loading ? (
        <EmptyState>Загрузка…</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>
          {items.length === 0 ? 'Шаблоны не загружены. Добавьте первый шаблон выше.' : 'Ничего не найдено.'}
        </EmptyState>
      ) : (
        <GroupBlocks
          sections={buildSections(
            filtered,
            (t) => ({ ...tplGroupOf(t), icon: FileText }),
            (t) => ({
              key: t.id,
              node: (
                <TemplateCard
                  tpl={t}
                  categoryName={tplGroupOf(t).name}
                  isDefault={isDefaultTpl(t)}
                  canEdit={canEdit}
                  fieldsOpen={openFields === t.id}
                  onToggleFields={() => setOpenFields(openFields === t.id ? null : t.id)}
                  onToggleDefault={() => toggleDefault(t, isDefaultTpl(t))}
                  onEdit={() => setEditTpl(t)}
                  onDelete={() => deleteTemplate(t.id)}
                />
              ),
            }),
            (a, b) => (catOrder.get(a.key) ?? 9999) - (catOrder.get(b.key) ?? 9999),
          )}
        />
      )}

      {editTpl && (
        <TemplateEditModal
          tpl={editTpl}
          categories={categories}
          onClose={() => setEditTpl(null)}
          onSaved={() => {
            setEditTpl(null);
            load(true);
          }}
        />
      )}
    </div>
  );
}

/** Модалка правки шаблона (PATCH /api/kb/templates/{id}). */
function TemplateEditModal({
  tpl,
  categories,
  onClose,
  onSaved,
}: {
  tpl: KbTemplate;
  categories: TplCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(tpl.title);
  const [description, setDescription] = useState(tpl.description || '');
  const [categoryId, setCategoryId] = useState(tpl.category_id ? String(tpl.category_id) : '');
  const [enabled, setEnabled] = useState(tpl.is_enabled);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setSaving(true);
    setErr('');
    try {
      await apiPatch(`/api/kb/templates/${tpl.id}`, {
        title: title.trim(),
        description: description.trim() || null,
        category_id: categoryId ? Number(categoryId) : null,
        is_enabled: enabled,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Ошибка соединения');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Редактирование шаблона" subtitle={tpl.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <label className={labelCls}>
          Название
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Описание
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Категория
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputCls}>
            <option value="">Без категории</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600 font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-4 h-4 accent-[#2563eb]"
          />
          Шаблон включён (доступен в генераторе документов)
        </label>
      </div>
      {err && <ErrorCallout>{err}</ErrorCallout>}
      <div className="flex justify-end gap-3">
        <SecondaryButton onClick={onClose}>Отмена</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}


/** Карточка шаблона внутри группы-блока. */
function TemplateCard({
  tpl: t,
  categoryName,
  isDefault,
  canEdit,
  fieldsOpen,
  onToggleFields,
  onToggleDefault,
  onEdit,
  onDelete,
}: {
  tpl: KbTemplate;
  categoryName: string;
  isDefault: boolean;
  canEdit: boolean;
  fieldsOpen: boolean;
  onToggleFields: () => void;
  onToggleDefault: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="bg-white border border-gray-100 rounded-xl p-2.5 shadow-sm flex flex-col gap-2 hover:border-gray-200 transition">
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-9 h-9 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center flex-shrink-0">
          <FileText size={18} />
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="font-bold text-sm text-[#0f1c3f] truncate" title={t.title}>
            {t.title}
          </span>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            {isDefault && (
              <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-600 text-[10px] font-bold px-2 py-0.5 rounded">
                <Star size={10} className="fill-amber-500 text-amber-500" /> По умолчанию
              </span>
            )}
            {!t.is_enabled && (
              <span className="bg-gray-100 text-gray-500 text-[10px] font-bold px-2 py-0.5 rounded">отключён</span>
            )}
            <span className="bg-gray-100 text-gray-500 text-[10px] font-bold px-2 py-0.5 rounded">{categoryName}</span>
          </div>
          <div className="text-xs text-gray-400 mt-1">
            {t.description ? `${t.description} • ` : ''}
            {t.fields_count > 0 ? (
              <button
                onClick={onToggleFields}
                className="text-[#2563eb] hover:underline inline-flex items-center gap-0.5"
              >
                полей: {t.fields_count}
                {fieldsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : (
              <span>справочный (без полей)</span>
            )}
          </div>
        </div>
      </div>

      {/* Просмотр схемы полей (упрощённый: только список) */}
      {fieldsOpen && t.fields.length > 0 && (
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-2 flex flex-wrap gap-1.5">
          {t.fields.map((f) => (
            <span
              key={f.name}
              className="bg-white border border-gray-200 text-slate-600 text-[11px] font-semibold px-2 py-1 rounded-lg"
              title={`${f.name}${f.type ? ` • ${f.type}` : ''}`}
            >
              {f.label || f.name}
              {f.required === false ? <span className="text-gray-400"> (необяз.)</span> : null}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center flex-wrap justify-between gap-2 border-t border-gray-50 pt-2">
        {canEdit && t.category_id ? (
          <button
            onClick={onToggleDefault}
            className={`text-[10px] font-bold px-2 py-1 rounded transition ${
              isDefault ? 'bg-amber-50 text-amber-600 hover:bg-amber-100' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
            title={isDefault ? 'Снять «по умолчанию»' : 'Сделать шаблоном по умолчанию в категории'}
          >
            {isDefault ? 'По умолчанию' : 'Сделать по умолчанию'}
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1 text-gray-400">
          <a
            href={`/kb/templates/${t.id}/view`}
            target="_blank"
            rel="noopener"
            className="p-1.5 hover:bg-gray-50 rounded-lg hover:text-slate-700 transition inline-flex"
            title="Предпросмотр шаблона"
          >
            <Eye size={16} />
          </a>
          <a
            href={`/api/kb/templates/${t.id}/download`}
            target="_blank"
            rel="noopener"
            className="p-1.5 hover:bg-gray-50 rounded-lg hover:text-slate-700 transition inline-flex"
            title="Скачать оригинал"
          >
            <Download size={16} />
          </a>
          {canEdit && (
            <>
              <button
                onClick={onEdit}
                className="p-1.5 hover:bg-gray-50 rounded-lg hover:text-slate-700 transition"
                title="Редактировать"
              >
                <Pencil size={16} />
              </button>
              <button
                onClick={onDelete}
                className="p-1.5 hover:bg-red-50 rounded-lg hover:text-red-600 transition"
                title="Удалить"
              >
                <Trash2 size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
