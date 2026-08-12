'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Globe, Plus, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError, timeAgo } from '@/lib/api';
import { Card, EmptyState, ErrorCallout, PrimaryButton, SearchInput } from '@/components/ui';
import GroupBlocks, { buildSections } from '@/components/kb/group-blocks';
import KbFilters, { type FilterDef } from '@/components/kb/filters-modal';

// Вкладка «Веб-источники» — порт loadSources/renderSources из kb.js.

interface KbSource {
  id: number;
  name: string;
  url: string;
  is_enabled: boolean;
  priority: number;
  refresh_interval_hours: number;
  last_crawled_at: string | null;
  last_status: string | null;
  document_id: number | null;
  doc_status: string | null;
  chunks_count: number;
}

const inputCls =
  'w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-[#2563eb] text-sm text-slate-700';

/** Группа источника — сайт (hostname), как в kb.js:765. */
function srcGroupOf(s: KbSource): { key: string; name: string } {
  let host = 'прочее';
  try {
    host = new URL(s.url).hostname.replace(/^www\./, '') || 'прочее';
  } catch {
    /* некорректный URL — в «прочее» */
  }
  return { key: host, name: host };
}

export default function SourcesTab({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<KbSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // Фильтры вкладки — все в модалке «Фильтры» (kb.html:285-310).
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [interval, setIntervalHours] = useState('24');
  const [submitting, setSubmitting] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await apiGet<{ items: KbSource[] }>('/api/kb/sources');
      setItems(data.items || []);
      setError('');
    } catch {
      if (!silent) setError('Не удалось загрузить источники.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, [load]);

  const addSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await apiPost('/api/kb/sources', {
        name: name.trim(),
        url: url.trim(),
        refresh_interval_hours: parseInt(interval || '24', 10),
      });
      setName('');
      setUrl('');
      setIntervalHours('24');
      load(true);
      // Индексация идёт в фоне — подтягиваем статус по мере готовности.
      timersRef.current.push(setTimeout(() => load(true), 3000));
      timersRef.current.push(setTimeout(() => load(true), 9000));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка соединения');
    } finally {
      setSubmitting(false);
    }
  };

  const patchSource = async (id: number, body: { priority?: number; is_enabled?: boolean }) => {
    try {
      await apiPatch(`/api/kb/sources/${id}`, body);
      load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось обновить источник.');
    }
  };

  const deleteSource = async (id: number) => {
    if (!window.confirm('Удалить источник?')) return;
    try {
      await apiDelete(`/api/kb/sources/${id}`);
      load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить источник.');
    }
  };

  // Фильтры вкладки — порт srcPredicate из kb.js:699 + группа + поиск.
  const q = search.trim().toLowerCase();
  const filtered = items.filter((s) => {
    if (filters.group && srcGroupOf(s).key !== filters.group) return false;
    if (q && !`${s.name} ${s.url} ${s.last_status || ''}`.toLowerCase().includes(q)) return false;
    const st = filters.state || '';
    if (st && s.is_enabled !== (st === 'on')) return false;
    const ix = filters.idx || '';
    if (ix === 'progress') {
      if (s.doc_status === 'indexed' || s.doc_status === 'failed') return false;
    } else if (ix && s.doc_status !== ix) return false;
    if (filters.priority && String(s.priority) !== filters.priority) return false;
    return true;
  });

  // Опции «Сайт» строим по полному списку (kb.js:165 fillGroupFilter).
  const hosts = [...new Set(items.map((s) => srcGroupOf(s).key))].sort((a, b) => a.localeCompare(b, 'ru'));
  const filterDefs: FilterDef[] = [
    {
      key: 'group',
      label: 'Сайт',
      options: [{ value: '', label: 'Все группы' }, ...hosts.map((h) => ({ value: h, label: h }))],
    },
    {
      key: 'state',
      label: 'Состояние источника',
      options: [
        { value: '', label: 'Любое' },
        { value: 'on', label: 'Активен' },
        { value: 'off', label: 'Отключён' },
      ],
    },
    {
      key: 'idx',
      label: 'Индексация содержимого',
      options: [
        { value: '', label: 'Любая' },
        { value: 'indexed', label: 'Готов' },
        { value: 'progress', label: 'Индексируется' },
        { value: 'failed', label: 'Ошибка' },
      ],
    },
    {
      key: 'priority',
      label: 'Приоритет в поиске',
      options: [
        { value: '', label: 'Любой' },
        { value: '3', label: 'Высокий' },
        { value: '2', label: 'Средний' },
        { value: '1', label: 'Низкий' },
      ],
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Форма добавления */}
      {canEdit && (
        <Card>
          <form onSubmit={addSource} className="flex flex-col gap-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Название источника"
              required
              className={inputCls}
            />
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              required
              className={inputCls}
            />
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-600 font-medium">
                Обновлять каждые
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={interval}
                  onChange={(e) => setIntervalHours(e.target.value)}
                  className={`${inputCls} w-24`}
                />
                часов
              </label>
              <PrimaryButton type="submit" disabled={submitting} className="sm:ml-auto">
                <Plus size={16} /> {submitting ? 'Добавление…' : 'Добавить источник'}
              </PrimaryButton>
            </div>
          </form>
        </Card>
      )}

      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Поиск по источникам…" />
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

      {/* Плитка групп по сайтам (kb.js:765) */}
      {loading ? (
        <EmptyState>Загрузка…</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>{items.length === 0 ? 'Источники не настроены.' : 'Ничего не найдено.'}</EmptyState>
      ) : (
        <GroupBlocks
          sections={buildSections(
            filtered,
            (s) => ({ ...srcGroupOf(s), icon: Globe }),
            (s) => ({
              key: s.id,
              node: (
                <SourceCard
                  source={s}
                  canEdit={canEdit}
                  onPatch={patchSource}
                  onDelete={deleteSource}
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

/** Карточка веб-источника внутри группы-блока. */
function SourceCard({
  source: s,
  canEdit,
  onPatch,
  onDelete,
}: {
  source: KbSource;
  canEdit: boolean;
  onPatch: (id: number, body: { priority?: number; is_enabled?: boolean }) => void;
  onDelete: (id: number) => void;
}) {
  // Состояние индексации распарсенного документа.
  let idxNote = 'индексируется…';
  if (s.doc_status === 'indexed') idxNote = `${s.chunks_count || 0} чанков`;
  else if (s.doc_status === 'failed') idxNote = 'ошибка парсинга';
  else if (!s.document_id) idxNote = 'нет данных';

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-2.5 shadow-sm flex flex-col gap-2 hover:border-gray-200 transition">
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-9 h-9 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center flex-shrink-0">
          <Globe size={18} />
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="font-bold text-sm text-[#0f1c3f] truncate">{s.name}</span>
          <a
            href={s.url}
            target="_blank"
            rel="noopener"
            className="text-xs text-[#2563eb] underline truncate mt-0.5"
            title={s.url}
          >
            {s.url}
          </a>
          <div className="text-xs text-gray-400 mt-0.5 truncate">
            интервал {s.refresh_interval_hours} ч •{' '}
            {s.last_crawled_at ? timeAgo(s.last_crawled_at) : 'ещё не парсился'} •{' '}
            {s.last_status || 'ещё не парсился'} • {idxNote}
          </div>
        </div>
      </div>

      <div className="flex items-center flex-wrap justify-between gap-2 border-t border-gray-50 pt-2">
        <div className="flex items-center gap-2">
          {canEdit ? (
            <select
              value={String(s.priority || 2)}
              onChange={(e) => onPatch(s.id, { priority: Number(e.target.value) })}
              className="px-2 py-1 bg-white border border-gray-200 rounded-lg text-xs font-bold text-gray-600 focus:outline-none focus:border-[#2563eb]"
              title="Приоритет в поиске"
            >
              <option value="3">Высокий</option>
              <option value="2">Средний</option>
              <option value="1">Низкий</option>
            </select>
          ) : (
            <span className="bg-gray-100 text-gray-600 text-[10px] font-bold px-2 py-1 rounded">
              {({ 1: 'Низкий', 2: 'Средний', 3: 'Высокий' } as Record<number, string>)[s.priority] || s.priority}
            </span>
          )}
          {canEdit ? (
            <button
              onClick={() => onPatch(s.id, { is_enabled: !s.is_enabled })}
              className={`text-[10px] font-bold px-2 py-1 rounded transition ${
                s.is_enabled
                  ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
              title={s.is_enabled ? 'Отключить источник' : 'Включить источник'}
            >
              {s.is_enabled ? 'Активен' : 'Отключён'}
            </button>
          ) : (
            <span
              className={`text-[10px] font-bold px-2 py-1 rounded ${
                s.is_enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'
              }`}
            >
              {s.is_enabled ? 'Активен' : 'Отключён'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-gray-400">
          {s.document_id && s.doc_status === 'indexed' && (
            <a
              href={`/kb/documents/${s.document_id}/view`}
              target="_blank"
              rel="noopener"
              className="p-1.5 hover:bg-gray-50 rounded-lg hover:text-slate-700 transition inline-flex"
              title="Предпросмотр распарсенного текста"
            >
              <Eye size={16} />
            </a>
          )}
          {canEdit && (
            <button
              onClick={() => onDelete(s.id)}
              className="p-1.5 hover:bg-red-50 rounded-lg hover:text-red-600 transition"
              title="Удалить"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}