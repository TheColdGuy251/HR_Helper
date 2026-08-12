'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Clock,
  MessageSquare,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost, timeAgo } from '@/lib/api';
import { ErrorCallout, PillTabs, SearchInput, StatusPill } from '@/components/ui';

// «Мои диалоги» — список чат-сессий с ассистентом.
// Порт static/js/dialogues.js, формы ответов — routes/dialogues.py.

const PAGE_SIZE = 20;

type Filter = 'active' | 'finished' | 'all';

interface LastMessage {
  role: string;
  text: string;
  ts: string | null;
}

interface DialogueItem {
  id: number;
  title: string;
  description: string | null;
  is_finished: boolean;
  created_at: string;
  last_activity: string;
  session_id: string | null;
  last_message: LastMessage | null;
  unread: boolean;
}

interface Stats {
  total: number;
  active: number;
  finished: number;
}

interface DialoguesResponse {
  success: boolean;
  items: DialogueItem[];
  stats: Stats;
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

interface CreateResponse {
  success: boolean;
  dialogue_id: number;
  session_id: string;
  title: string;
}

const TABS: { key: Filter; label: string }[] = [
  { key: 'active', label: 'Активные' },
  { key: 'finished', label: 'Решённые' },
  { key: 'all', label: 'Все диалоги' },
];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Неизвестная ошибка');

export default function DialoguesPage() {
  const router = useRouter();

  const [items, setItems] = useState<DialogueItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, active: 0, finished: 0 });
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1); // сколько страниц подгружено («Показать ещё»)
  const [filter, setFilter] = useState<Filter>('active');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState(''); // поиск с debounce
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reqRef = useRef(0); // отсекаем ответы устаревших запросов

  // Поиск: 250 мс без ввода → новый запрос с первой страницы.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setPages(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (silent = false) => {
      const seq = ++reqRef.current;
      if (!silent) setLoading(true);
      try {
        const responses = await Promise.all(
          Array.from({ length: pages }, (_, i) => {
            const params = new URLSearchParams({
              filter,
              page: String(i + 1),
              page_size: String(PAGE_SIZE),
            });
            if (query) params.set('search', query);
            return apiGet<DialoguesResponse>(`/api/dialogues?${params.toString()}`);
          })
        );
        if (seq !== reqRef.current) return;
        // Страницы могли «съехать» между запросами — схлопываем дубли по id.
        const byId = new Map<number, DialogueItem>();
        for (const r of responses) for (const it of r.items || []) byId.set(it.id, it);
        setItems([...byId.values()]);
        setStats(responses[0].stats);
        setTotal(responses[0].total || 0);
        setError(null);
      } catch (e) {
        if (seq === reqRef.current) setError(errMsg(e));
      } finally {
        if (seq === reqRef.current) setLoading(false);
      }
    },
    [filter, query, pages]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Push-события (SSE) + редкий фолбэк при видимой вкладке — как в dialogues.js.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(true), 400);
    };
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener('hr:dialogues-changed', refresh);
    window.addEventListener('hr:unread-changed', refresh);
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(onVisible, 120000);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener('hr:dialogues-changed', refresh);
      window.removeEventListener('hr:unread-changed', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Создание одним кликом: сервер переиспользует пустой диалог, если он есть.
  const createDialogue = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const data = await apiPost<CreateResponse>('/api/dialogues', {});
      if (data.session_id) router.push(`/chat/${data.session_id}`);
      else setError('Сервер не вернул сессию диалога');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  const openDialogue = (d: DialogueItem) => {
    if (d.session_id) router.push(`/chat/${d.session_id}`);
  };

  const toggleFinished = async (d: DialogueItem) => {
    const prev = items;
    setItems((list) => list.map((x) => (x.id === d.id ? { ...x, is_finished: !x.is_finished } : x)));
    try {
      await apiPost(`/api/dialogues/${d.id}/${d.is_finished ? 'reopen' : 'finish'}`);
      void load(true);
    } catch (e) {
      setItems(prev);
      setError(errMsg(e));
    }
  };

  const removeDialogue = async (d: DialogueItem) => {
    if (!window.confirm(`Удалить диалог «${d.title}»? Переписка будет потеряна.`)) return;
    const prev = items;
    setItems((list) => list.filter((x) => x.id !== d.id));
    try {
      await apiDelete(`/api/dialogues/${d.id}`);
      void load(true);
    } catch (e) {
      setItems(prev);
      setError(errMsg(e));
    }
  };

  const isEmptyOverall = !loading && stats.total === 0 && !query;

  return (
    <div className="max-w-5xl w-full mx-auto px-4 py-8 flex-1 flex flex-col gap-6">
      {/* Заголовок, фильтр, создание */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-[#2563eb] rounded-2xl flex items-center justify-center text-white shadow-md shadow-blue-200">
            <MessageSquare size={24} />
          </div>
          <h1 className="text-2xl font-bold text-[#0f1c3f]">Мои диалоги</h1>
        </div>

        {/* justify-center + w-full: на узких экранах группа переносится на свою строку,
            и без этого фильтры с кнопкой «прилипали» к левому краю. */}
        <div className="flex w-full sm:w-auto flex-wrap items-center justify-center gap-3">
          <PillTabs
            tabs={TABS}
            active={filter}
            onChange={(k) => {
              setFilter(k);
              setPages(1);
            }}
          />
          <button
            type="button"
            onClick={createDialogue}
            disabled={creating}
            className="bg-[#2563eb] text-white px-5 py-3 rounded-xl font-semibold text-sm flex items-center gap-2 hover:bg-[#1e40af] transition shadow-md shadow-blue-100 disabled:opacity-60"
          >
            <Plus size={18} />
            <span>{creating ? 'Создаём…' : 'Начать диалог'}</span>
          </button>
        </div>
      </div>

      {/* Статистика */}
      <div className="grid grid-cols-3 bg-white border border-gray-100 rounded-2xl p-1 shadow-sm text-center text-sm font-medium">
        <div className="py-3 border-r border-gray-100">
          <span className="text-[#2563eb] font-bold mr-1">{stats.active}</span>{' '}
          <span className="text-gray-400">АКТИВНЫХ</span>
        </div>
        <div className="py-3 border-r border-gray-100">
          <span className="text-slate-700 font-bold mr-1">{stats.finished}</span>{' '}
          <span className="text-gray-400">РЕШЁННЫХ</span>
        </div>
        <div className="py-3">
          <span className="text-slate-700 font-bold mr-1">{stats.total}</span>{' '}
          <span className="text-gray-400">ВСЕГО</span>
        </div>
      </div>

      {/* className="w-full": родитель — вертикальный flex, дефолтный flex-1 растянул бы
          поиск по высоте и отбросил список диалогов к низу окна. */}
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Поиск по названию…"
        className="w-full"
      />

      {error && <ErrorCallout>{error}</ErrorCallout>}

      {/* Hero — когда диалогов ещё нет */}
      {isEmptyOverall ? (
        <section className="flex flex-col items-center text-center gap-4 py-10">
          <h2 className="text-3xl md:text-4xl font-black text-[#0f1c3f] tracking-tight leading-tight">
            Спроси. <span className="text-gradient">Остальное за HR-помощником.</span>
          </h2>
          <p className="text-sm md:text-base text-gray-400 max-w-xl font-medium leading-relaxed">
            Опишите задачу своими словами: ассистент найдёт нужные положения и регламенты ТИУ,
            подготовит документ и подскажет, к кому обратиться.
          </p>
          <button
            type="button"
            onClick={createDialogue}
            disabled={creating}
            className="bg-[#2563eb] text-white px-6 py-3 rounded-xl font-semibold text-sm inline-flex items-center gap-2 hover:bg-[#1e40af] transition shadow-md shadow-blue-100 disabled:opacity-60"
          >
            <Sparkles size={18} /> Начать первый диалог
          </button>
        </section>
      ) : (
        <div className="flex flex-col gap-4">
          {loading && items.length === 0 ? (
            <p className="text-center text-gray-400 py-10 bg-white rounded-2xl border border-dashed">
              Загрузка диалогов…
            </p>
          ) : items.length === 0 ? (
            <p className="text-center text-gray-400 py-10 bg-white rounded-2xl border border-dashed">
              {query ? 'Ничего не найдено' : 'Диалоги не найдены'}
            </p>
          ) : (
            items.map((d) => (
              // Вся карточка — одна кликабельная область (как в ленте новостей).
              <article
                key={d.id}
                role="button"
                tabIndex={0}
                aria-label={`Открыть диалог «${d.title}»`}
                onClick={() => openDialogue(d)}
                onKeyDown={(e) => {
                  // Enter/Space на вложенной кнопке не должен открывать диалог:
                  // click мы гасим stopPropagation'ом, а keydown всплывает отдельно.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openDialogue(d);
                  }
                }}
                className={`group bg-white border border-gray-100 rounded-2xl p-6 shadow-sm flex flex-col gap-3 hover:shadow-md transition ${
                  d.session_id ? 'cursor-pointer' : 'cursor-default'
                }`}
              >
                <div className="flex justify-between items-start gap-3">
                  <h2 className="font-bold text-lg text-[#0f1c3f] group-hover:text-[#2563eb] transition flex items-center gap-2 min-w-0">
                    {d.unread && (
                      <span
                        className="w-2 h-2 rounded-full bg-[#2563eb] shrink-0"
                        title="Есть непрочитанный ответ"
                      />
                    )}
                    <span className="truncate">{d.title}</span>
                  </h2>
                  <StatusPill tone={d.is_finished ? 'emerald' : 'blue'}>
                    {d.is_finished ? 'Решён' : 'Активен'}
                  </StatusPill>
                </div>

                {d.last_message ? (
                  <p className="text-sm text-slate-500 leading-relaxed line-clamp-2">
                    <span className="font-semibold text-slate-700">
                      {d.last_message.role === 'user' ? 'Вы:' : 'Ассистент:'}
                    </span>{' '}
                    {d.last_message.text}
                  </p>
                ) : (
                  <p className="text-sm text-gray-400 font-medium">
                    {d.description || 'Пока нет сообщений — только черновик'}
                  </p>
                )}

                {d.last_message?.ts && (
                  <div className="text-xs text-gray-400 font-medium flex items-center gap-1.5">
                    <Clock size={12} /> {timeAgo(d.last_message.ts)}
                  </div>
                )}

                {/* Кнопки внутри кликабельной карточки — гасим всплытие, чтобы не открыть чат. */}
                <div className="flex items-center justify-between pt-2 border-t border-gray-50 mt-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleFinished(d);
                    }}
                    className={`flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-xl transition ${
                      d.is_finished
                        ? 'text-slate-600 bg-gray-100 hover:bg-gray-200'
                        : 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100'
                    }`}
                  >
                    {d.is_finished ? <RotateCcw size={14} /> : <Check size={14} />}
                    <span>{d.is_finished ? 'Возобновить' : 'Завершить'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeDialogue(d);
                    }}
                    className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition"
                    title="Удалить диалог"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            ))
          )}

          {items.length > 0 && items.length < total && (
            <button
              type="button"
              onClick={() => setPages((p) => p + 1)}
              disabled={loading}
              className="border border-gray-200 bg-white text-slate-600 px-5 py-3 rounded-xl font-semibold text-sm hover:bg-gray-50 transition disabled:opacity-60"
            >
              {loading ? 'Загрузка…' : `Показать ещё (${total - items.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
