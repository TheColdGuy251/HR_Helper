'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Newspaper, Pencil, Plus, Trash2, User as UserIcon } from 'lucide-react';
import { apiDelete, apiGet, timeAgo } from '@/lib/api';
import NewsEditor, { type NewsItem } from '@/components/news/editor';
import {
  EmptyState,
  ErrorCallout,
  PageHeader,
  PageShell,
  PrimaryButton,
  SearchInput,
  StatusPill,
} from '@/components/ui';

// Лента новостей HR — порт static/js/news.js (роуты: routes/news.py).
// Порядок постов задаёт бэкенд (закреплённые сверху) — на клиенте не пересортировываем.

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Неизвестная ошибка');

function NewsFeed() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get('edit');

  const [items, setItems] = useState<NewsItem[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // null — редактор закрыт; { post: null } — создание новой новости
  const [editor, setEditor] = useState<{ post: NewsItem | null } | null>(null);
  const autoOpened = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await apiGet<{ can_edit: boolean; items: NewsItem[] }>('/api/news');
      setItems(d.items ?? []);
      setCanEdit(!!d.can_edit);
    } catch (e) {
      setError(`Не удалось загрузить новости: ${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Автооткрытие редактора по /news?edit=ID (переход со страницы статьи).
  useEffect(() => {
    if (autoOpened.current || !editId || loading) return;
    const post = items.find((p) => String(p.id) === editId);
    if (post) {
      autoOpened.current = true;
      setEditor({ post });
    }
  }, [editId, items, loading]);

  const clearEditQuery = useCallback(() => {
    if (editId) router.replace('/news');
  }, [editId, router]);

  function closeEditor() {
    setEditor(null);
    clearEditQuery();
  }

  function afterSave() {
    setEditor(null);
    clearEditQuery();
    load();
  }

  async function removePost(post: NewsItem) {
    if (!window.confirm(`Удалить новость «${post.title}»? Действие необратимо.`)) return;
    const prev = items;
    setError(null);
    setItems((list) => list.filter((p) => p.id !== post.id)); // оптимистично
    try {
      await apiDelete(`/api/news/${post.id}`);
    } catch (e) {
      setItems(prev); // откат
      setError(`Не удалось удалить: ${errMsg(e)}`);
    }
  }

  // Клиентский поиск по заголовку и текстовой выжимке.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (p) =>
        (p.title || '').toLowerCase().includes(q) || (p.excerpt || '').toLowerCase().includes(q)
    );
  }, [items, query]);

  return (
    <PageShell>
      <PageHeader
        icon={Newspaper}
        title="Новости HR-отдела"
        subtitle="Что изменилось в кадровых процессах, анонсы и полезные материалы."
        actions={
          canEdit ? (
            <PrimaryButton onClick={() => setEditor({ post: null })}>
              <Plus size={18} /> Создать пост
            </PrimaryButton>
          ) : undefined
        }
      />

      {/* className="w-full": внутри вертикального PageShell дефолтный flex-1 растянул бы
          поиск по высоте и отбросил ленту к низу окна. */}
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Поиск по новостям…"
        className="w-full"
      />

      {error && <ErrorCallout>{error}</ErrorCallout>}

      <div className="flex flex-col gap-4">
        {loading ? (
          <EmptyState>Загрузка новостей…</EmptyState>
        ) : !filtered.length ? (
          <EmptyState>{items.length ? 'Ничего не найдено' : 'Пока нет новостей.'}</EmptyState>
        ) : (
          filtered.map((p) => (
            <article
              key={p.id}
              onClick={() => router.push(`/news/${p.id}`)}
              className="group bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden hover:shadow-md transition cursor-pointer"
            >
              {p.preview_image && (
                <div className="h-48 sm:h-60 bg-gray-50 overflow-hidden">
                  {/* обложка — первая картинка из тела поста */}
                  <img
                    src={p.preview_image}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                </div>
              )}

              <div className="p-6 flex flex-col gap-3">
                <div className="flex justify-between items-start gap-3">
                  <h2 className="font-bold text-lg text-[#0f1c3f] group-hover:text-[#2563eb] transition">
                    {p.title}
                  </h2>
                  {p.is_pinned && (
                    <span className="shrink-0">
                      <StatusPill>Закреплено</StatusPill>
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 text-xs text-gray-400 font-medium">
                  <UserIcon size={13} className="shrink-0" />
                  <span className="truncate">{p.author}</span>
                  <span>·</span>
                  <span className="whitespace-nowrap">{timeAgo(p.created_at)}</span>
                  {p.updated_at && p.updated_at !== p.created_at && (
                    <span className="whitespace-nowrap">· изменено</span>
                  )}
                </div>

                {p.excerpt && (
                  <p className="text-sm text-slate-500 leading-relaxed line-clamp-3">{p.excerpt}</p>
                )}

                {canEdit && (
                  <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-50">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditor({ post: p });
                      }}
                      className="flex items-center gap-2 text-xs font-semibold text-[#2563eb] bg-blue-50 px-4 py-2 rounded-xl hover:bg-blue-100 transition"
                    >
                      <Pencil size={14} /> Редактировать
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removePost(p);
                      }}
                      title="Удалить новость"
                      className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      {editor && <NewsEditor post={editor.post} onClose={closeEditor} onSaved={afterSave} />}
    </PageShell>
  );
}

export default function NewsPage() {
  return (
    <Suspense>
      <NewsFeed />
    </Suspense>
  );
}
