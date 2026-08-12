'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Circle, Pencil, Trash2, User as UserIcon, X } from 'lucide-react';
import { apiDelete, apiGet, apiPost } from '@/lib/api';
import { newsBodyCss, type NewsItem } from '@/components/news/editor';
import { plural } from '@/components/messenger/types';
import { ErrorCallout, PageShell, StatusPill } from '@/components/ui';

// Страница новости — порт static/js/news_article.js + templates/news_article.html.
// Отдельного GET /api/news/{id} на бэкенде нет: берём пост из ленты GET /api/news.

// ─────────────────────────── типы (по _poll_state в routes/news.py) ───────────────────────────

interface PollVoter {
  name: string;
  initials: string;
}

interface PollOption {
  id: number;
  text: string;
  votes: number;
  mine: boolean;
  voters: PollVoter[];
}

interface PollState {
  id: number;
  question: string;
  description: string | null;
  allow_multiple: boolean;
  show_voters: boolean;
  total_votes: number;
  options: PollOption[];
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Неизвестная ошибка');

/** Дата публикации: как в легаси-шаблоне (%d.%m.%Y %H:%M). */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Курсор-лупа на картинках тела: подсказка, что открывается лайтбокс.
const ARTICLE_EXTRA_CSS = `
.news-body img { cursor: zoom-in; }
.news-body .news-doc img { cursor: default; }
`;

// ─────────────────────────── голосование ───────────────────────────

function PollBlock({ postId }: { postId: string }) {
  const [poll, setPoll] = useState<PollState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiGet<{ poll: PollState | null }>(`/api/news/${postId}/poll`);
      setPoll(d.poll);
    } catch {
      /* нет опроса или нет доступа — просто не показываем блок */
    }
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  async function vote(optionId: number) {
    setError(null);
    try {
      // Бэкенд возвращает пересчитанный опрос; на всякий случай перезагружаем, если его нет.
      const d = await apiPost<{ poll: PollState | null }>('/api/news/poll/vote', {
        option_id: optionId,
      });
      if (d.poll) setPoll(d.poll);
      else await load();
    } catch (e) {
      setError(`Не удалось учесть голос: ${errMsg(e)}`);
    }
  }

  if (!poll) return null;

  const sub = [`${poll.total_votes} ${plural(poll.total_votes, 'голос', 'голоса', 'голосов')}`];
  if (poll.allow_multiple) sub.push('неск. ответов');
  if (poll.show_voters) sub.push('открытое');

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm flex flex-col gap-3">
      <div>
        <div className="font-bold text-[#0f1c3f]">{poll.question}</div>
        {poll.description && <div className="text-sm text-gray-500 mt-0.5">{poll.description}</div>}
      </div>

      <div className="flex flex-col gap-2">
        {poll.options.map((o) => {
          const pct = poll.total_votes ? Math.round((o.votes / poll.total_votes) * 100) : 0;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => vote(o.id)}
              title={o.mine ? 'Нажмите, чтобы снять голос' : 'Проголосовать'}
              className={`text-left rounded-xl border px-4 py-3 transition ${
                o.mine
                  ? 'border-[#2563eb] bg-blue-50/60'
                  : 'border-gray-100 hover:border-[#2563eb] hover:bg-blue-50/30'
              }`}
            >
              <div className="flex items-center gap-2 text-sm">
                {o.mine ? (
                  <CheckCircle2 size={16} className="text-[#2563eb] shrink-0" />
                ) : (
                  <Circle size={16} className="text-gray-300 shrink-0" />
                )}
                <span className="flex-1 min-w-0 break-words text-slate-700">{o.text}</span>
                <span className="shrink-0 text-xs font-semibold text-gray-400">
                  {o.votes} · {pct}%
                </span>
              </div>

              <div className="mt-2 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full rounded-full bg-[#2563eb] transition-all" style={{ width: `${pct}%` }} />
              </div>

              {poll.show_voters && o.voters && o.voters.length > 0 && (
                <div className="mt-2 flex items-center gap-1 flex-wrap">
                  {o.voters.slice(0, 8).map((v, i) => (
                    <span
                      key={`${v.name}-${i}`}
                      title={v.name}
                      className="w-6 h-6 rounded-full bg-blue-100 text-[#2563eb] text-[10px] font-bold flex items-center justify-center"
                    >
                      {v.initials || '?'}
                    </span>
                  ))}
                  {o.voters.length > 8 && (
                    <span className="text-[11px] text-gray-400">+{o.voters.length - 8}</span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="text-xs text-gray-400 font-medium">{sub.join(' · ')}</div>
      {error && <ErrorCallout>{error}</ErrorCallout>}
    </div>
  );
}

// ─────────────────────────── страница статьи ───────────────────────────

export default function NewsArticlePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [post, setPost] = useState<NewsItem | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await apiGet<{ can_edit: boolean; items: NewsItem[] }>('/api/news');
        if (cancelled) return;
        setPost((d.items ?? []).find((p) => String(p.id) === String(id)) ?? null);
        setCanEdit(!!d.can_edit);
      } catch (e) {
        if (!cancelled) setError(`Не удалось загрузить новость: ${errMsg(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Лайтбокс: закрытие по Escape + блокировка прокрутки страницы.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [lightbox]);

  // Делегированный клик по картинкам тела статьи → лайтбокс.
  function onBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    const img = (e.target as HTMLElement).closest('img');
    if (!(img instanceof HTMLImageElement)) return;
    e.preventDefault(); // картинка может лежать внутри ссылки
    setLightbox({ src: img.currentSrc || img.src, alt: img.alt || '' });
  }

  async function removePost() {
    if (!post) return;
    if (!window.confirm('Удалить эту новость? Действие необратимо.')) return;
    try {
      await apiDelete(`/api/news/${post.id}`);
      router.push('/news');
    } catch (e) {
      setError(`Не удалось удалить: ${errMsg(e)}`);
    }
  }

  const bodyCss = useMemo(() => newsBodyCss('.news-body') + ARTICLE_EXTRA_CSS, []);
  const edited = !!post?.updated_at && post.updated_at !== post.created_at;

  return (
    <PageShell>
      <style>{bodyCss}</style>

      {/* Панель навигации и действий */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link
          href="/news"
          className="inline-flex items-center gap-2 text-sm font-semibold text-[#2563eb] hover:text-[#1e40af] transition"
        >
          <ArrowLeft size={16} /> Назад к новостям
        </Link>

        {canEdit && post && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push(`/news?edit=${post.id}`)}
              className="flex items-center gap-2 text-xs font-semibold text-[#2563eb] bg-blue-50 px-4 py-2 rounded-xl hover:bg-blue-100 transition"
            >
              <Pencil size={14} /> Редактировать
            </button>
            <button
              type="button"
              onClick={removePost}
              className="flex items-center gap-2 text-xs font-semibold text-red-500 bg-red-50 px-4 py-2 rounded-xl hover:bg-red-100 transition"
            >
              <Trash2 size={14} /> Удалить
            </button>
          </div>
        )}
      </div>

      {error && <ErrorCallout>{error}</ErrorCallout>}

      {loading ? (
        <p className="text-center text-gray-400 py-10 bg-white rounded-2xl border border-dashed">
          Загрузка новости…
        </p>
      ) : !post ? (
        <div className="bg-white border border-gray-100 rounded-2xl p-10 shadow-sm text-center">
          <h2 className="text-lg font-bold text-[#0f1c3f]">Новость не найдена</h2>
          <p className="text-sm text-gray-500 mt-1">
            Возможно, её удалили или ссылка устарела.
          </p>
          <Link
            href="/news"
            className="inline-block mt-4 text-sm font-semibold text-[#2563eb] hover:underline"
          >
            Ко всем новостям
          </Link>
        </div>
      ) : (
        <>
          <article className="bg-white border border-gray-100 rounded-2xl p-6 sm:p-8 shadow-sm flex flex-col gap-4">
            {post.is_pinned && (
              <span className="self-start">
                <StatusPill>Закреплено</StatusPill>
              </span>
            )}

            <h1 className="text-2xl sm:text-3xl font-bold text-[#0f1c3f] leading-tight">
              {post.title}
            </h1>

            <div className="flex items-center gap-1.5 text-xs text-gray-400 font-medium flex-wrap">
              <UserIcon size={13} className="shrink-0" />
              <span>{post.author}</span>
              <span>·</span>
              <span>{fmtDate(post.created_at)}</span>
              {edited && <span>· изменено {fmtDate(post.updated_at)}</span>}
            </div>

            {/* HTML санитизирован на бэкенде (utils/htmlsanitize.py) */}
            <div
              className="news-body text-[15px] leading-relaxed"
              onClick={onBodyClick}
              dangerouslySetInnerHTML={{ __html: post.body_html }}
            />
          </article>

          {/* Голосование есть в ленте (poll ≠ null) — актуальные счётчики тянем отдельно */}
          {post.poll && <PollBlock postId={String(post.id)} />}
        </>
      )}

      {/* Лайтбокс картинок статьи */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[95] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            aria-label="Закрыть"
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-xl bg-white/10 text-white hover:bg-white/20 transition"
          >
            <X size={20} />
          </button>
          <img
            src={lightbox.src}
            alt={lightbox.alt}
            className="max-w-full max-h-[90vh] object-contain rounded-xl shadow-2xl"
          />
        </div>
      )}
    </PageShell>
  );
}
