'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Book,
  ClipboardList,
  Clock,
  Download,
  Eye,
  FileArchive,
  FileSignature,
  FileText,
  FolderOpen,
  Globe,
  Landmark,
  ScanText,
  ShieldAlert,
  SlidersHorizontal,
  Stamp,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiDelete, apiPatch, apiUpload, ApiError } from '@/lib/api';
import { EmptyState, ErrorCallout, PrimaryButton, SearchInput, SecondaryButton } from '@/components/ui';
import GroupBlocks, { buildSections, type GroupSection } from '@/components/kb/group-blocks';
import KbFilters, { type FilterDef } from '@/components/kb/filters-modal';

// Вкладка «Документы» — порт логики kb.js (loadDocs/renderDocs/uploadDocument/pollDocStatus).

interface DocProgress {
  label: string;
  done: number;
  total: number;
  percent: number;
}

interface PiiWarning {
  fio_count?: number;
  reason?: string;
  samples?: string[];
}

interface KbDoc {
  id: number;
  title: string;
  filename: string | null;
  source_type: string;
  source_uri: string | null;
  status: string; // pending | parsing | indexed | failed
  priority: number;
  document_kind: string | null;
  issuer: string | null;
  effective_from: string | null;
  effective_to: string | null;
  tags: string[];
  is_archived: boolean;
  review_status: 'expired' | 'review_due' | null;
  chunks_count: number;
  progress: DocProgress | null;
  ocr_applied: boolean;
  pii_warning: PiiWarning | null;
  created_at: string;
  indexed_at: string | null;
  error: string | null;
}

const KIND_LABELS: Record<string, string> = {
  code: 'Кодекс',
  law: 'Закон',
  regulation: 'Положение',
  order: 'Приказ',
  manual: 'Инструкция',
  other: 'Прочее',
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  indexed: { label: 'Готов', cls: 'bg-emerald-50 text-emerald-600' },
  pending: { label: 'В очереди', cls: 'bg-amber-50 text-amber-600' },
  parsing: { label: 'Индексация', cls: 'bg-blue-50 text-[#2563eb]' },
  failed: { label: 'Ошибка', cls: 'bg-red-50 text-red-600' },
};

const PRIORITY_LABELS: Record<number, string> = { 1: 'Низкий', 2: 'Средний', 3: 'Высокий' };

// Пункты быстрого меню приоритета — порядок и цвета точек как в kb.js:606.
const PRIORITY_MENU: { value: number; label: string; color: string }[] = [
  { value: 3, label: 'Высокий', color: '#16a34a' },
  { value: 2, label: 'Средний', color: '#1e40af' },
  { value: 1, label: 'Низкий', color: '#ca8a04' },
];

// Иконки групп документов (порт KIND_ICONS из kb.js:369).
const KIND_ICONS: Record<string, LucideIcon> = {
  code: Book,
  law: Landmark,
  regulation: FileSignature,
  order: Stamp,
  manual: ClipboardList,
  other: FolderOpen,
  web: Globe,
};

// Порядок групп: известные типы → веб → теги (по алфавиту) → «Прочее» в конце.
const KIND_ORDER = ['code', 'law', 'regulation', 'order', 'manual', 'web'];

/** Группа документа: тип (если указан и не «прочее») → первый тег → «Прочее».
 *  Порт docGroupOf из kb.js:375. */
function docGroupOf(d: KbDoc): { key: string; name: string; icon: LucideIcon } {
  if (d.source_type === 'web') return { key: 'web', name: 'Веб-страницы', icon: Globe };
  const kind = d.document_kind;
  if (kind && kind !== 'other' && KIND_LABELS[kind]) {
    return { key: kind, name: KIND_LABELS[kind], icon: KIND_ICONS[kind] || FolderOpen };
  }
  const tag = (d.tags || [])[0];
  if (tag) return { key: `tag:${tag}`, name: tag[0].toUpperCase() + tag.slice(1), icon: Tag };
  return { key: 'other', name: 'Прочее', icon: FolderOpen };
}

/** Сортировка секций документов — порт docSections из kb.js:386. */
function sortDocSections(a: GroupSection, b: GroupSection): number {
  const rank = (s: GroupSection): [number, number, string] => {
    const i = KIND_ORDER.indexOf(s.key);
    if (i >= 0) return [0, i, ''];
    if (s.key.startsWith('tag:')) return [1, 0, s.name.toLowerCase()];
    return [2, 0, ''];
  };
  const [ga, ia, na] = rank(a);
  const [gb, ib, nb] = rank(b);
  return ga - gb || ia - ib || na.localeCompare(nb, 'ru');
}

const ACCEPT_DOCS =
  '.pdf,.docx,.doc,.txt,.md,.rst,.csv,.rtf,.odt,.xlsx,.xlsm,.xls,.ods,.pptx,.ppt,.odp,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff';

const inputCls =
  'w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-[#2563eb] text-sm text-slate-700';
const labelCls = 'text-xs font-bold text-gray-500 flex flex-col gap-1';

interface UploadBanner {
  kind: 'progress' | 'success' | 'error';
  text: string;
  percent: number;
}

/** Простая модалка в стиле Tyuiu.bot-main. */
function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-xl p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
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

export default function DocsTab({ canEdit }: { canEdit: boolean }) {
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // Фильтры вкладки — все живут в модалке «Фильтры» (kb.html:243-283).
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<UploadBanner | null>(null);
  const [metaDoc, setMetaDoc] = useState<KbDoc | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  // Документ, за которым следим после свежей загрузки (как pollDocStatus в kb.js).
  const watchRef = useRef<{ id: number; title: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/kb/documents', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { items: KbDoc[] };
      const items = data.items || [];
      setDocs(items);
      setError('');

      // Следим за свежезагруженным документом: живой прогресс в баннере.
      const watch = watchRef.current;
      if (watch) {
        const doc = items.find((d) => d.id === watch.id);
        if (doc && (doc.status === 'pending' || doc.status === 'parsing') && doc.progress) {
          const p = doc.progress;
          setBanner({
            kind: 'progress',
            text: `«${doc.title || watch.title}»: ${p.label}${p.total ? ` — ${p.done}/${p.total} чанков` : ''} (${p.percent}%)`,
            percent: p.percent,
          });
        } else if (doc && doc.status === 'indexed') {
          setBanner({
            kind: 'success',
            text: `Документ «${doc.title || watch.title}» проиндексирован (${doc.chunks_count || 0} чанков).`,
            percent: 100,
          });
          watchRef.current = null;
          hideRef.current = setTimeout(() => setBanner(null), 4000);
        } else if (doc && doc.status === 'failed') {
          setBanner({
            kind: 'error',
            text: `Не удалось проиндексировать «${doc.title || watch.title}»: ${doc.error || 'ошибка парсинга'}`,
            percent: 100,
          });
          watchRef.current = null;
        } else if (!doc) {
          // Дубликат — placeholder удалён индексатором.
          setBanner({ kind: 'success', text: 'Документ уже есть в базе знаний.', percent: 100 });
          watchRef.current = null;
          hideRef.current = setTimeout(() => setBanner(null), 4000);
        }
      }

      // Пока есть документы в обработке — поллинг каждые 2 секунды.
      if (timerRef.current) clearTimeout(timerRef.current);
      const busy = items.some((d) => d.status === 'pending' || d.status === 'parsing');
      if (busy) timerRef.current = setTimeout(() => load(true), 2000);
    } catch {
      if (!silent) setError('Не удалось загрузить список документов.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (hideRef.current) clearTimeout(hideRef.current);
    };
  }, [load]);

  const uploadDocument = async (file: File) => {
    if (hideRef.current) clearTimeout(hideRef.current);
    setBanner({ kind: 'progress', text: `Загрузка и индексация «${file.name}»…`, percent: 15 });
    const form = new FormData();
    form.append('file', file);
    try {
      const data = await apiUpload<{ success: boolean; document: { id: number; title: string } }>(
        '/api/kb/upload',
        form
      );
      setBanner({
        kind: 'progress',
        text: `Документ «${data.document.title}» загружен, идёт индексация…`,
        percent: 30,
      });
      watchRef.current = { id: data.document.id, title: data.document.title };
      load(true);
    } catch (e) {
      setBanner({
        kind: 'error',
        text: `Ошибка: ${e instanceof ApiError ? e.message : 'соединение прервано'}`,
        percent: 100,
      });
    }
  };

  const import1c = async (file: File) => {
    if (hideRef.current) clearTimeout(hideRef.current);
    setBanner({ kind: 'progress', text: `Импорт из 1С: «${file.name}»…`, percent: 20 });
    const form = new FormData();
    form.append('file', file);
    try {
      const data = await apiUpload<{ queued: number; skipped: number }>('/api/kb/import/1c', form);
      setBanner({
        kind: 'success',
        text: `Импортировано документов: ${data.queued}, пропущено: ${data.skipped}. Идёт индексация…`,
        percent: 100,
      });
      load(true);
      hideRef.current = setTimeout(() => setBanner(null), 6000);
    } catch (e) {
      setBanner({
        kind: 'error',
        text: `Ошибка: ${e instanceof ApiError ? e.message : 'соединение прервано'}`,
        percent: 100,
      });
    }
  };

  // Быстрая смена приоритета из «пилюли» карточки (kb.js:606 showPriorityMenu).
  const setPriority = async (id: number, priority: number) => {
    try {
      await apiPatch(`/api/kb/documents/${id}`, { priority });
      load(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось изменить приоритет.');
    }
  };

  const deleteDoc = async (id: number) => {
    if (!window.confirm('Удалить документ?')) return;
    try {
      await apiDelete(`/api/kb/documents/${id}`);
      load(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось удалить документ.');
    }
  };

  // Клиентские фильтры — порт docPredicate из kb.js:196 + поиск + фильтр по группе.
  const q = search.trim().toLowerCase();
  const filtered = docs.filter((d) => {
    if (filters.group && docGroupOf(d).key !== filters.group) return false;
    if (q) {
      const hay = [d.title, d.filename, d.issuer, KIND_LABELS[d.document_kind || ''], ...(d.tags || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const st = filters.status || '';
    if (st === 'busy') {
      if (d.status !== 'pending' && d.status !== 'parsing') return false;
    } else if (st && d.status !== st) return false;
    if (filters.priority && String(d.priority) !== filters.priority) return false;
    const rv = filters.review || '';
    if (rv === 'fresh') {
      if (d.review_status) return false;
    } else if (rv && d.review_status !== rv) return false;
    const ft = filters.feature || '';
    if (ft === 'noarchive') {
      if (d.is_archived) return false;
    } else if (ft === 'archived') {
      if (!d.is_archived) return false;
    } else if (ft === 'ocr') {
      if (!d.ocr_applied) return false;
    } else if (ft === 'pii') {
      if (!d.pii_warning) return false;
    }
    return true;
  });

  const expired = docs.filter((d) => d.review_status === 'expired').length;
  const due = docs.filter((d) => d.review_status === 'review_due').length;

  // Опции фильтра «Группа» строим по ПОЛНОМУ списку (kb.js:165 fillGroupFilter),
  // иначе выбранная группа исчезала бы из списка вместе с отфильтрованными.
  const allSections = buildSections(docs, docGroupOf, (d) => ({ key: d.id, node: null }), sortDocSections);
  const filterDefs: FilterDef[] = [
    {
      key: 'group',
      label: 'Группа',
      options: [
        { value: '', label: 'Все группы' },
        ...allSections.map((s) => ({ value: s.key, label: s.name })),
      ],
    },
    {
      key: 'status',
      label: 'Статус индексации',
      options: [
        { value: '', label: 'Любой' },
        { value: 'indexed', label: 'Готов' },
        { value: 'busy', label: 'В обработке' },
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
    {
      key: 'review',
      label: 'Актуальность',
      options: [
        { value: '', label: 'Любая' },
        { value: 'expired', label: 'Устаревшие' },
        { value: 'review_due', label: 'Пора пересмотреть' },
        { value: 'fresh', label: 'Актуальные' },
      ],
    },
    {
      key: 'feature',
      label: 'Особенности',
      options: [
        { value: '', label: 'Все' },
        { value: 'archived', label: 'Архивные' },
        { value: 'noarchive', label: 'Без архивных' },
        { value: 'ocr', label: 'Распознаны (OCR)' },
        { value: 'pii', label: 'С меткой «ПДн?»' },
      ],
    },
  ];

  // Сводка по актуальности — плашка над плиткой групп (kb.js:480 prefixHtml).
  const summaryNote =
    expired > 0 || due > 0 ? (
      <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 text-xs text-amber-700 font-medium flex items-center gap-2">
        <Clock size={14} className="shrink-0" />
        <span>
          Требуют внимания:{' '}
          {[expired ? `${expired} с истёкшим сроком` : null, due ? `${due} без пересмотра больше года` : null]
            .filter(Boolean)
            .join(', ')}
          . Обновите текст/даты действия или архивируйте устаревшие.
        </span>
      </div>
    ) : null;

  const docCard = (d: KbDoc) => (
    <DocCard doc={d} canEdit={canEdit} onMeta={setMetaDoc} onDelete={deleteDoc} onPriority={setPriority} />
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Панель действий */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        {canEdit && (
          <>
            <input
              type="file"
              ref={fileRef}
              accept={ACCEPT_DOCS}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) uploadDocument(f);
              }}
            />
            <input
              type="file"
              ref={zipRef}
              accept=".zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) import1c(f);
              }}
            />
            <PrimaryButton onClick={() => fileRef.current?.click()}>
              <Upload size={16} /> Загрузить документ
            </PrimaryButton>
            <SecondaryButton onClick={() => zipRef.current?.click()} title="Импорт документов из выгрузки 1С (ZIP)">
              <FileArchive size={16} /> Импорт из 1С
            </SecondaryButton>
          </>
        )}
        <SearchInput value={search} onChange={setSearch} placeholder="Поиск по документам…" />
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

      <p className="text-[11px] text-gray-400 -mt-1">
        Поддерживаются: PDF (сканы — авто-OCR), DOCX/DOC, XLSX/XLS, RTF, ODT/ODS, TXT, MD. «Импорт из 1С» — ZIP с файлами.
      </p>

      {/* Баннер загрузки с прогрессом */}
      {banner && (
        <div
          className={`rounded-xl border p-4 text-xs font-semibold flex flex-col gap-2 ${
            banner.kind === 'error'
              ? 'bg-red-50 border-red-100 text-red-600'
              : banner.kind === 'success'
                ? 'bg-emerald-50 border-emerald-100 text-emerald-700'
                : 'bg-blue-50 border-blue-100 text-blue-800'
          }`}
        >
          <span>{banner.text}</span>
          {banner.kind === 'progress' && (
            <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#2563eb] rounded-full transition-all"
                style={{ width: `${Math.min(100, Math.max(0, banner.percent))}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error && <ErrorCallout>{error}</ErrorCallout>}

      {/* Список документов: плитка сворачиваемых групп (kb.js:30 renderGroupBlocks) */}
      {loading ? (
        <EmptyState>Загрузка…</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>
          {docs.length === 0 ? 'В базе знаний пока нет документов. Загрузите первый файл выше.' : 'Ничего не найдено.'}
        </EmptyState>
      ) : (
        <GroupBlocks
          note={summaryNote}
          sections={buildSections(
            filtered,
            docGroupOf,
            (d) => ({ key: d.id, node: docCard(d) }),
            sortDocSections,
          )}
        />
      )}

      {metaDoc && (
        <DocMetaModal
          doc={metaDoc}
          onClose={() => setMetaDoc(null)}
          onSaved={() => {
            setMetaDoc(null);
            load(true);
          }}
        />
      )}
    </div>
  );
}

/** «Пилюля» приоритета с быстрым меню (kb.js:341 priorityPill / :606 showPriorityMenu).
 *  Меню — position: fixed, иначе его обрежет overflow группы-блока. */
function PriorityPill({
  value,
  canEdit,
  onPick,
}: {
  value: number;
  canEdit: boolean;
  onPick: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const label = PRIORITY_LABELS[value] || String(value);
  const dot = PRIORITY_MENU.find((o) => o.value === value)?.color || '#94a3b8';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onMove = () => setOpen(false); // прокрутка/ресайз уводят меню от «пилюли»
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  if (!canEdit) {
    return (
      <span className="bg-gray-100 text-gray-600 text-[10px] font-bold px-2 py-1 rounded" title="Приоритет в поиске">
        {label}
      </span>
    );
  }

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 170;
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
    setOpen(true);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Приоритет в поиске — нажмите, чтобы изменить"
        className="inline-flex items-center gap-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-[10px] font-bold px-2 py-1 rounded transition"
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} aria-hidden />
        {label}
      </button>

      {open && pos && (
        <div
          ref={menuRef}
          role="menu"
          style={{ top: pos.top, left: pos.left, width: 170 }}
          className="fixed z-[90] bg-white border border-gray-100 rounded-xl shadow-lg py-1 animate-fade-in"
        >
          {PRIORITY_MENU.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                if (o.value !== value) onPick(o.value);
              }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-blue-50 transition ${
                o.value === value ? 'font-bold text-[#2563eb]' : 'text-slate-600'
              }`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: o.color }} aria-hidden />
              {o.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Карточка документа внутри группы-блока (kb.js docItemHtml). */
function DocCard({
  doc: d,
  canEdit,
  onMeta,
  onDelete,
  onPriority,
}: {
  doc: KbDoc;
  canEdit: boolean;
  onMeta: (d: KbDoc) => void;
  onDelete: (id: number) => void;
  onPriority: (id: number, priority: number) => void;
}) {
  const isWeb = d.source_type === 'web';
  const prog = d.status === 'pending' || d.status === 'parsing' ? d.progress : null;
  const st = STATUS_META[d.status] || { label: d.status, cls: 'bg-gray-100 text-gray-600' };
  const meta = [
    d.filename,
    prog ? `${prog.label}${prog.total ? ` — ${prog.done}/${prog.total} чанков` : ''}` : null,
    !prog && d.chunks_count ? `${d.chunks_count} чанков` : null,
    new Date(d.indexed_at || d.created_at).toLocaleString('ru-RU'),
  ].filter(Boolean);

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-2.5 shadow-sm flex flex-col gap-2 hover:border-gray-200 transition">
      <div className="flex items-start gap-3 min-w-0">
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
            d.status === 'failed' ? 'bg-red-50 text-red-500' : 'bg-blue-50 text-blue-600'
          }`}
        >
          {isWeb ? <Globe size={18} /> : <FileText size={18} />}
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          {d.status === 'indexed' ? (
            <a
              href={`/kb/documents/${d.id}/view`}
              target="_blank"
              rel="noopener"
              className="font-bold text-sm text-[#0f1c3f] hover:text-[#2563eb] transition truncate"
              title="Открыть для просмотра"
            >
              {d.title}
            </a>
          ) : (
            <span className="font-bold text-sm text-[#0f1c3f] truncate">{d.title}</span>
          )}
          <div className="text-xs text-gray-400 mt-0.5 truncate" title={meta.join(' • ')}>
            {meta.join(' • ')}
            {d.error ? ` • ${d.error}` : ''}
          </div>
          {/* Бейджи */}
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {d.review_status === 'expired' && (
              <span
                className="inline-flex items-center gap-1 bg-red-50 text-red-600 text-[10px] font-bold px-2 py-0.5 rounded"
                title="Вышел срок действия — обновите или архивируйте"
              >
                <AlertTriangle size={10} /> устарел
              </span>
            )}
            {d.review_status === 'review_due' && (
              <span
                className="inline-flex items-center gap-1 bg-amber-50 text-amber-600 text-[10px] font-bold px-2 py-0.5 rounded"
                title="Не пересматривался больше года — проверьте актуальность"
              >
                <Clock size={10} /> пора пересмотреть
              </span>
            )}
            {d.is_archived && (
              <span
                className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 text-[10px] font-bold px-2 py-0.5 rounded"
                title="Архивная редакция"
              >
                <Archive size={10} /> архив
              </span>
            )}
            {d.document_kind && (
              <span className="bg-blue-50 text-[#2563eb] text-[10px] font-bold px-2 py-0.5 rounded" title="Тип документа">
                {KIND_LABELS[d.document_kind] || d.document_kind}
              </span>
            )}
            {d.issuer && (
              <span className="bg-gray-100 text-gray-600 text-[10px] font-bold px-2 py-0.5 rounded" title="Издатель">
                {d.issuer}
              </span>
            )}
            {d.ocr_applied && (
              <span
                className="inline-flex items-center gap-1 bg-violet-50 text-violet-600 text-[10px] font-bold px-2 py-0.5 rounded"
                title="Текст распознан через OCR"
              >
                <ScanText size={10} /> OCR
              </span>
            )}
            {d.pii_warning && (
              <span
                className="inline-flex items-center gap-1 bg-red-50 text-red-600 text-[10px] font-bold px-2 py-0.5 rounded"
                title={`Возможны персональные данные: ${d.pii_warning.reason || ''}. В общей базе знаний ПДн быть не должно — используйте раздел «Персональные данные».`}
              >
                <ShieldAlert size={10} /> ПДн?
              </span>
            )}
            {(d.tags || []).slice(0, 5).map((t) => (
              <span key={t} className="bg-gray-100 text-gray-500 text-[10px] font-bold px-2 py-0.5 rounded">
                #{t}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center flex-wrap justify-between gap-2 border-t border-gray-50 pt-2">
        <div className="flex items-center gap-2">
          <PriorityPill
            value={d.priority}
            canEdit={canEdit}
            onPick={(v) => onPriority(d.id, v)}
          />
          <span className={`text-[10px] font-bold px-2 py-1 rounded ${st.cls}`}>
            {prog ? `Индексация ${prog.percent}%` : st.label}
          </span>
        </div>
        <div className="flex items-center gap-1 text-gray-400">
          {d.status === 'indexed' && (
            <>
              <a
                href={`/kb/documents/${d.id}/view`}
                target="_blank"
                rel="noopener"
                className="p-1.5 hover:bg-gray-50 rounded-lg hover:text-slate-700 transition inline-flex"
                title="Открыть для просмотра"
              >
                <Eye size={16} />
              </a>
              <a
                href={`/api/kb/documents/${d.id}/download`}
                target="_blank"
                rel="noopener"
                className="p-1.5 hover:bg-gray-50 rounded-lg hover:text-slate-700 transition inline-flex"
                title={isWeb ? 'Открыть источник' : 'Скачать файл'}
              >
                <Download size={16} />
              </a>
            </>
          )}
          {canEdit && (
            <>
              <button
                onClick={() => onMeta(d)}
                className="p-1.5 hover:bg-gray-50 rounded-lg hover:text-slate-700 transition"
                title="Изменить метаданные"
              >
                <SlidersHorizontal size={16} />
              </button>
              <button
                onClick={() => onDelete(d.id)}
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

/** Модалка метаданных документа (PATCH /api/kb/documents/{id}). */
function DocMetaModal({ doc, onClose, onSaved }: { doc: KbDoc; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(doc.title || '');
  const [kind, setKind] = useState(doc.document_kind || '');
  const [issuer, setIssuer] = useState(doc.issuer || '');
  const [priority, setPriority] = useState(String(doc.priority || 2));
  const [from, setFrom] = useState(doc.effective_from || '');
  const [to, setTo] = useState(doc.effective_to || '');
  const [tags, setTags] = useState((doc.tags || []).join(', '));
  const [archived, setArchived] = useState(!!doc.is_archived);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setSaving(true);
    setErr('');
    try {
      await apiPatch(`/api/kb/documents/${doc.id}`, {
        title: title.trim(),
        document_kind: kind || null,
        issuer: issuer.trim() || null,
        priority: Number(priority),
        effective_from: from || null,
        effective_to: to || null,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        is_archived: archived,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Ошибка соединения');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Метаданные документа" subtitle={doc.title} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className={labelCls}>
          Название
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Тип документа
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
            <option value="">— не указан —</option>
            <option value="code">Кодекс</option>
            <option value="law">Закон</option>
            <option value="regulation">Положение / Регламент</option>
            <option value="order">Приказ</option>
            <option value="manual">Инструкция</option>
            <option value="other">Прочее</option>
          </select>
        </label>
        <label className={labelCls}>
          Источник (издатель)
          <input
            type="text"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="Минтруд, Учёный совет ТИУ…"
            className={inputCls}
          />
        </label>
        <label className={labelCls}>
          Приоритет в поиске
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={inputCls}>
            <option value="1">Низкий</option>
            <option value="2">Средний</option>
            <option value="3">Высокий</option>
          </select>
        </label>
        <label className={labelCls}>
          Действует с
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Действует по
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        </label>
        <label className={`${labelCls} sm:col-span-2`}>
          Теги (через запятую)
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="увольнение, отпуска, оплата"
            className={inputCls}
          />
          <span className="text-[11px] text-gray-400 font-medium">
            Рекомендуемые: приём, увольнение, отпуска, дисциплина, оплата, охрана_труда, социальные_гарантии, обучение,
            договоры
          </span>
        </label>
        <label className="sm:col-span-2 flex items-center gap-2 text-sm text-slate-600 font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
            className="w-4 h-4 accent-[#2563eb]"
          />
          Архивная редакция — исключить из поиска по умолчанию
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
