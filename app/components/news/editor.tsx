'use client';
import { useEffect, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Quote,
  Strikethrough,
  Underline,
  Vote,
  X,
} from 'lucide-react';
import { apiPatch, apiPost, apiUpload, formatBytes } from '@/lib/api';
import { PrimaryButton, SecondaryButton } from '@/components/ui';
import NewsImageEditor from '@/components/news/image-editor';

// Редактор новости — порт HR Helper/static/js/news.js.
// Форматы запросов/ответов сверены с HR Helper/routes/news.py.

// ─────────────────────────── типы (по routes/news.py) ───────────────────────────

/** PollPayload / _poll_edit_dict: голосование без счётчиков (для редактора). */
export interface NewsPollDraft {
  question: string;
  description: string;
  allow_multiple: boolean;
  show_voters: boolean;
  options: string[];
}

/** Элемент ленты — _post_dict() бэкенда. */
export interface NewsItem {
  id: number;
  title: string;
  body_html: string;
  attachments: { media_id: number; name: string; size: number; is_image: boolean; url: string }[];
  preview_image: string | null;
  excerpt: string;
  poll: NewsPollDraft | null;
  author: string;
  is_pinned: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/** Ответ POST /api/news/upload → {success, media}. */
interface UploadedMedia {
  id: number;
  name: string;
  size: number;
  is_image: boolean;
  url: string;
}

// ─────────────────── CSS контента (тело статьи и редактор) ───────────────────
// Инлайн-стили режутся санитайзером бэкенда, поэтому legacy использует классы
// news-align-* (блоки) и news-img-* (картинки) — воспроизводим их здесь.
// Иконки карточек документов — SVG-фоном (FontAwesome в Next-порте нет).

const FILE_ICON =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'/%3E%3Cpath d='M14 2v4a2 2 0 0 0 2 2h4'/%3E%3Cpath d='M16 13H8'/%3E%3Cpath d='M16 17H8'/%3E%3C/svg%3E")`;
const DOWNLOAD_ICON =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/%3E%3Cpolyline points='7 10 12 15 17 10'/%3E%3Cline x1='12' y1='15' x2='12' y2='3'/%3E%3C/svg%3E")`;

/** Типографика санитизированного HTML, scope — селектор контейнера. */
export function newsBodyCss(scope: string): string {
  const s = scope;
  return `
${s} { color: #1e293b; word-break: break-word; }
${s} p { margin: 0 0 14px; }
${s} h2 { font-size: 1.35em; font-weight: 700; color: #0f1c3f; margin: 22px 0 10px; }
${s} h3 { font-size: 1.15em; font-weight: 700; color: #0f1c3f; margin: 18px 0 8px; }
${s} h4 { font-size: 1.05em; font-weight: 700; color: #0f1c3f; margin: 16px 0 6px; }
${s} ul { list-style: disc; margin: 0 0 14px; padding-left: 26px; }
${s} ol { list-style: decimal; margin: 0 0 14px; padding-left: 26px; }
${s} li { margin: 4px 0; }
${s} blockquote { margin: 16px 0; padding: 10px 18px; border-left: 4px solid #3b82f6; background: #f8fafc; color: #475569; border-radius: 0 10px 10px 0; }
${s} a:not(.news-doc-main):not(.news-doc-dl) { color: #2563eb; text-decoration: underline; }
${s} img { max-width: 100%; height: auto; border-radius: 12px; margin: 10px 0; display: inline-block; }
${s} pre { background: #f1f5f9; padding: 14px; border-radius: 12px; overflow-x: auto; }
${s} hr { border: 0; border-top: 1px solid #e2e8f0; margin: 18px 0; }
${s} .news-align-left { text-align: left; }
${s} .news-align-center { text-align: center; }
${s} .news-align-right { text-align: right; }
${s} .news-align-justify { text-align: justify; }
${s} img.news-img-left { display: block; margin-left: 0; margin-right: auto; }
${s} img.news-img-center { display: block; margin-left: auto; margin-right: auto; }
${s} img.news-img-right { display: block; margin-left: auto; margin-right: 0; }
${s} img.news-img-full { display: block; width: 100%; }
${s} .news-doc { display: flex; align-items: center; gap: 12px; margin: 12px 0; padding: 12px 14px; width: 100%; box-sizing: border-box; background: #fff; border: 1px solid rgba(30, 64, 175, 0.18); border-left: 4px solid #2563eb; border-radius: 14px; }
${s} .news-doc:hover { box-shadow: 0 8px 22px rgba(15, 23, 42, 0.12); }
${s} .news-doc-main { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; color: #1e293b; text-decoration: none; }
${s} .news-doc-ic { width: 40px; height: 40px; flex-shrink: 0; border-radius: 10px; background-color: #2563eb; background-image: ${FILE_ICON}; background-repeat: no-repeat; background-position: center; background-size: 20px 20px; }
${s} .news-doc-info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
${s} .news-doc-title { font-weight: 600; font-size: 14px; color: #1e3a8a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
${s} .news-doc-size { font-size: 12px; color: #64748b; margin-top: 2px; }
${s} .news-doc-dl { width: 36px; height: 36px; flex-shrink: 0; border-radius: 10px; text-decoration: none; background-color: #2563eb; background-image: ${DOWNLOAD_ICON}; background-repeat: no-repeat; background-position: center; background-size: 16px 16px; }
${s} .news-doc-dl:hover { background-color: #1e40af; }
${s} .news-doc-ic i, ${s} .news-doc-dl i { display: none; }
`;
}

// Дополнительные стили только для contenteditable-поля редактора.
const EDITOR_EXTRA_CSS = `
.news-body-input:empty::before { content: attr(data-placeholder); color: #cbd5e1; }
.news-body-input img.news-img-selected { outline: 3px solid #3b82f6; outline-offset: 2px; }
`;

// ─────────────────────────── утилиты ───────────────────────────

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]
  );

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** FA-классы по расширению — как legacy (в Next скрыты, но сохраняют вид в старом UI). */
function faFileIcon(name: string): string {
  const e = (name.split('.').pop() || '').toLowerCase();
  if (e === 'pdf') return 'fa-file-pdf';
  if (['doc', 'docx', 'rtf', 'odt'].includes(e)) return 'fa-file-word';
  if (['xls', 'xlsx', 'xlsm', 'csv', 'ods'].includes(e)) return 'fa-file-excel';
  if (['ppt', 'pptx', 'odp'].includes(e)) return 'fa-file-powerpoint';
  if (['zip', 'rar', '7z'].includes(e)) return 'fa-file-zipper';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(e)) return 'fa-file-image';
  return 'fa-file-lines';
}

/** Карточка документа в теле (структура и классы — как в legacy news.js).
    Основная ссылка ведёт напрямую на файл: страницы /news/media/{id}/view в порте нет. */
function docCardHtml(m: UploadedMedia): string {
  return (
    '<span class="news-doc" contenteditable="false">' +
    `<a class="news-doc-main" href="${esc(m.url)}" target="_blank" rel="noopener" title="Открыть">` +
    `<span class="news-doc-ic"><i class="fas ${faFileIcon(m.name)}"></i></span>` +
    '<span class="news-doc-info">' +
    `<span class="news-doc-title">${esc(m.name)}</span>` +
    `<span class="news-doc-size">${formatBytes(m.size)}</span>` +
    '</span></a>' +
    `<a class="news-doc-dl" href="${esc(m.url)}?download=1" title="Скачать" aria-label="Скачать"><i class="fas fa-download"></i></a>` +
    '</span>'
  );
}

// ─────────────────────────── кнопка тулбара ───────────────────────────

function TbBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()} /* не терять выделение в contenteditable */
      onClick={onClick}
      className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-white hover:text-[#2563eb] hover:shadow-sm transition"
    >
      {children}
    </button>
  );
}

const TbSep = () => <span className="w-px h-5 bg-gray-200 mx-1" aria-hidden />;

// ─────────────────────────── модалка голосования ───────────────────────────

function PollModal({
  initial,
  onCancel,
  onSave,
}: {
  initial: NewsPollDraft | null;
  onCancel: () => void;
  onSave: (p: NewsPollDraft) => void;
}) {
  const [question, setQuestion] = useState(initial?.question ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [multi, setMulti] = useState(initial?.allow_multiple ?? false);
  const [voters, setVoters] = useState(initial?.show_voters ?? false);
  const [options, setOptions] = useState<string[]>(
    initial && initial.options.length ? [...initial.options] : ['', '']
  );
  const [err, setErr] = useState('');

  const setOpt = (i: number, v: string) => setOptions((o) => o.map((x, j) => (j === i ? v : x)));
  const addOpt = () => setOptions((o) => (o.length < 12 ? [...o, ''] : o));
  const rmOpt = (i: number) => setOptions((o) => (o.length > 2 ? o.filter((_, j) => j !== i) : o));

  function submit() {
    const q = question.trim();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!q) { setErr('Введите вопрос.'); return; }
    if (opts.length < 2) { setErr('Нужно минимум 2 варианта.'); return; }
    onSave({
      question: q,
      description: description.trim(),
      allow_multiple: multi,
      show_voters: voters,
      options: opts,
    });
  }

  const inputCls =
    'w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-slate-700 focus:outline-none focus:border-[#2563eb]';

  return (
    <div
      className="fixed inset-0 z-[95] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="bg-white w-full max-w-lg max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Голосование"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <span className="font-bold text-[#0f1c3f]">Голосование</span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Закрыть"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-slate-700 hover:bg-gray-100 transition"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1 flex flex-col gap-3">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={300}
            placeholder="Вопрос"
            className={inputCls}
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Описание (необязательно)"
            className={`${inputCls} resize-none`}
          />

          <div className="flex flex-col gap-2">
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={o}
                  onChange={(e) => setOpt(i, e.target.value)}
                  maxLength={300}
                  placeholder={`Вариант ${i + 1}`}
                  className={inputCls}
                />
                {options.length > 2 && (
                  <button
                    type="button"
                    title="Убрать"
                    onClick={() => rmOpt(i)}
                    className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {options.length < 12 && (
            <button
              type="button"
              onClick={addOpt}
              className="self-start inline-flex items-center gap-1.5 text-sm font-semibold text-[#2563eb] hover:text-[#1e40af] transition"
            >
              <Plus size={15} /> Добавить вариант
            </button>
          )}

          <div className="flex flex-col gap-2 pt-1">
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={multi}
                onChange={(e) => setMulti(e.target.checked)}
                className="w-4 h-4 accent-[#2563eb]"
              />
              Несколько ответов
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={voters}
                onChange={(e) => setVoters(e.target.checked)}
                className="w-4 h-4 accent-[#2563eb]"
              />
              Открытое (видно, кто голосовал)
            </label>
          </div>

          {err && <p className="text-[13px] font-medium text-red-500">{err}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100">
          <SecondaryButton onClick={onCancel}>Отмена</SecondaryButton>
          <PrimaryButton onClick={submit}>Готово</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── редактор поста ───────────────────────────

export default function NewsEditor({
  post,
  onClose,
  onSaved,
}: {
  post: NewsItem | null; // null — создание нового
  onClose: () => void;
  onSaved: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const activeImg = useRef<HTMLImageElement | null>(null); // выбранная картинка (для выравнивания)
  const enterStreak = useRef(0);
  const imgFileRef = useRef<HTMLInputElement>(null);
  const docFileRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState(post?.title ?? '');
  const [pinned, setPinned] = useState(post?.is_pinned ?? false);
  const [poll, setPoll] = useState<NewsPollDraft | null>(post?.poll ?? null);
  const [pollOpen, setPollOpen] = useState(false);
  const [status, setStatus] = useState<{ text: string; err?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  // Картинка тела, открытая в редакторе изображений (двойной клик по ней).
  const [editImg, setEditImg] = useState<HTMLImageElement | null>(null);

  // Префилл тела + блокировка прокрутки страницы под модалкой.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.innerHTML = post?.body_html ?? '';
    try {
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch { /* не критично */ }
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── выделение: вставка/форматирование идут по месту курсора ──
  function saveSel() {
    const s = window.getSelection();
    if (s && s.rangeCount && bodyRef.current?.contains(s.anchorNode)) {
      savedRange.current = s.getRangeAt(0);
    }
  }
  function restoreSel() {
    const el = bodyRef.current;
    if (!el) return;
    el.focus();
    if (savedRange.current) {
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(savedRange.current);
    }
  }

  function setActiveImg(img: HTMLImageElement | null) {
    if (activeImg.current && activeImg.current !== img) {
      activeImg.current.classList.remove('news-img-selected');
    }
    activeImg.current = img;
    if (img) img.classList.add('news-img-selected');
  }

  // ── форматирование (document.execCommand — как legacy) ──
  function exec(cmd: string) {
    restoreSel();
    document.execCommand(cmd, false);
    saveSel();
  }
  function toggleBlock(tag: 'h2' | 'blockquote') {
    restoreSel();
    // Тумблер: повторный клик возвращает обычный абзац.
    const cur = (document.queryCommandValue('formatBlock') || '').toLowerCase();
    document.execCommand('formatBlock', false, cur === tag ? '<p>' : `<${tag}>`);
    saveSel();
  }

  function currentBlock(): HTMLElement | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const n = s.anchorNode;
    let el: HTMLElement | null = n ? (n.nodeType === 1 ? (n as HTMLElement) : n.parentElement) : null;
    const blocks = ['P', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'LI', 'DIV', 'FIGURE', 'PRE'];
    while (el && el !== bodyRef.current) {
      if (blocks.includes(el.tagName)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Выравнивание классами: inline-style режется санитайзером бэкенда.
  function setAlign(dir: 'left' | 'center' | 'right' | 'justify') {
    if (activeImg.current) {
      // Выбрана картинка — выравниваем её (она может лежать не в абзаце).
      const map: Record<typeof dir, string> = {
        left: 'news-img-left',
        center: 'news-img-center',
        right: 'news-img-right',
        justify: 'news-img-full',
      };
      activeImg.current.classList.remove('news-img-left', 'news-img-center', 'news-img-right', 'news-img-full');
      activeImg.current.classList.add(map[dir]);
      return;
    }
    restoreSel();
    const b = currentBlock();
    if (!b) return;
    b.classList.remove('news-align-left', 'news-align-center', 'news-align-right', 'news-align-justify');
    if (dir !== 'left') b.classList.add(`news-align-${dir}`); // left — по умолчанию
    saveSel();
  }

  function insertLink() {
    const url = window.prompt('Адрес ссылки (https://…):', 'https://');
    if (!url) return;
    restoreSel();
    document.execCommand('createLink', false, url);
    saveSel();
  }

  // ── двойной Enter на пустой строке выходит из цитаты ──
  function closestTag(tag: string): HTMLElement | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const n = s.anchorNode;
    let el: HTMLElement | null = n ? (n.nodeType === 1 ? (n as HTMLElement) : n.parentElement) : null;
    while (el && el !== bodyRef.current) {
      if (el.tagName === tag) return el;
      el = el.parentElement;
    }
    return null;
  }
  function onBodyKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      const bq = closestTag('BLOCKQUOTE');
      if (bq) {
        enterStreak.current += 1;
        if (enterStreak.current >= 2) {
          e.preventDefault();
          enterStreak.current = 0;
          // убрать пустую строку от первого Enter и выйти абзацем ПОСЛЕ цитаты
          while (
            bq.lastChild &&
            (bq.lastChild.nodeName === 'BR' ||
              (bq.lastChild.nodeType === 3 && !bq.lastChild.textContent?.trim()))
          ) {
            bq.removeChild(bq.lastChild);
          }
          const p = document.createElement('p');
          p.appendChild(document.createElement('br'));
          bq.parentNode?.insertBefore(p, bq.nextSibling);
          const r = document.createRange();
          r.setStart(p, 0);
          r.collapse(true);
          const s = window.getSelection();
          s?.removeAllRanges();
          s?.addRange(r);
          saveSel();
        }
        return;
      }
    }
    enterStreak.current = 0;
  }

  // ── загрузка и вставка картинок/документов по месту курсора ──
  async function uploadFile(file: File): Promise<UploadedMedia> {
    const fd = new FormData();
    fd.append('file', file);
    const d = await apiUpload<{ success: boolean; media: UploadedMedia }>('/api/news/upload', fd);
    return d.media;
  }
  function insertAtCursor(html: string) {
    restoreSel();
    document.execCommand('insertHTML', false, html);
    saveSel();
  }

  async function onImgPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setStatus({ text: 'Загрузка картинки…' });
    try {
      const m = await uploadFile(f);
      insertAtCursor(`<img src="${esc(m.url)}" alt="${esc(m.name)}">`);
      setStatus(null);
    } catch (err) {
      setStatus({ text: 'Не удалось загрузить: ' + errMsg(err), err: true });
    }
  }

  async function onDocPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setStatus({ text: 'Загрузка документа…' });
    try {
      const m = await uploadFile(f);
      insertAtCursor(docCardHtml(m) + '&nbsp;');
      setStatus(null);
    } catch (err) {
      setStatus({ text: 'Не удалось загрузить: ' + errMsg(err), err: true });
    }
  }

  // ── сохранение (PostPayload: title, body_html, attachments, is_pinned, poll) ──
  async function save() {
    setActiveImg(null); // не сохранять подсветку выбранной картинки
    const t = title.trim();
    const body_html = (bodyRef.current?.innerHTML ?? '').trim();
    if (!t && !body_html) {
      setStatus({ text: 'Заполните заголовок или текст.', err: true });
      return;
    }
    // attachments всегда [] — файлы встроены в body_html, бэкенд привязывает
    // их сам по ссылкам /api/news/media/{id} (_bind_media), как в legacy.
    const payload = {
      title: t,
      body_html,
      attachments: [],
      is_pinned: pinned,
      poll: poll && poll.options.length >= 2 ? poll : null,
    };
    setSaving(true);
    setStatus({ text: 'Сохранение…' });
    try {
      if (post) await apiPatch(`/api/news/${post.id}`, payload);
      else await apiPost('/api/news', payload);
      onSaved();
    } catch (err) {
      setSaving(false);
      setStatus({ text: 'Ошибка сохранения: ' + errMsg(err), err: true });
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <style>{newsBodyCss('.news-body-input') + EDITOR_EXTRA_CSS}</style>

      <div
        className="bg-white w-full max-w-3xl max-h-[92vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Редактор новости"
      >
        {/* Шапка */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <span className="font-bold text-[#0f1c3f]">
            {post ? 'Редактирование новости' : 'Новая новость'}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-slate-700 hover:bg-gray-100 transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Тело */}
        <div className="px-6 py-5 overflow-y-auto flex-1 flex flex-col gap-4">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={500}
            autoFocus
            placeholder="Заголовок новости"
            autoComplete="off"
            className="w-full text-xl font-bold text-[#0f1c3f] placeholder:text-gray-300 border-b-2 border-gray-200 focus:border-[#2563eb] outline-none pb-2 bg-transparent"
          />

          {/* Панель форматирования */}
          <div className="flex flex-wrap items-center gap-0.5 p-1.5 bg-gray-50 border border-gray-100 rounded-xl sticky top-0 z-10">
            <TbBtn title="Жирный" onClick={() => exec('bold')}><Bold size={15} /></TbBtn>
            <TbBtn title="Курсив" onClick={() => exec('italic')}><Italic size={15} /></TbBtn>
            <TbBtn title="Подчёркнутый" onClick={() => exec('underline')}><Underline size={15} /></TbBtn>
            <TbBtn title="Зачёркнутый" onClick={() => exec('strikeThrough')}><Strikethrough size={15} /></TbBtn>
            <TbSep />
            <TbBtn title="Заголовок" onClick={() => toggleBlock('h2')}><Heading2 size={15} /></TbBtn>
            <TbBtn title="Цитата" onClick={() => toggleBlock('blockquote')}><Quote size={15} /></TbBtn>
            <TbBtn title="Маркированный список" onClick={() => exec('insertUnorderedList')}><List size={15} /></TbBtn>
            <TbBtn title="Нумерованный список" onClick={() => exec('insertOrderedList')}><ListOrdered size={15} /></TbBtn>
            <TbSep />
            <TbBtn title="По левому краю" onClick={() => setAlign('left')}><AlignLeft size={15} /></TbBtn>
            <TbBtn title="По центру" onClick={() => setAlign('center')}><AlignCenter size={15} /></TbBtn>
            <TbBtn title="По правому краю" onClick={() => setAlign('right')}><AlignRight size={15} /></TbBtn>
            <TbBtn title="По ширине" onClick={() => setAlign('justify')}><AlignJustify size={15} /></TbBtn>
            <TbSep />
            <TbBtn title="Ссылка" onClick={insertLink}><Link2 size={15} /></TbBtn>
            <TbBtn title="Вставить картинку" onClick={() => { saveSel(); imgFileRef.current?.click(); }}>
              <ImagePlus size={15} />
            </TbBtn>
            <TbBtn title="Прикрепить документ" onClick={() => { saveSel(); docFileRef.current?.click(); }}>
              <Paperclip size={15} />
            </TbBtn>
            <TbBtn title="Добавить голосование" onClick={() => setPollOpen(true)}><Vote size={15} /></TbBtn>
          </div>

          {/* Текст новости */}
          <div
            ref={bodyRef}
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Текст новости. Ставьте курсор в нужное место и добавляйте картинки и документы…"
            className="news-body-input min-h-[220px] max-h-[46vh] overflow-y-auto border border-gray-200 rounded-xl px-4 py-3 text-[15px] leading-relaxed text-slate-700 focus:outline-none focus:border-[#2563eb]"
            onKeyUp={saveSel}
            onMouseUp={saveSel}
            onKeyDown={onBodyKeyDown}
            onClick={(e) => setActiveImg((e.target as HTMLElement).closest('img'))}
            onDoubleClick={(e) => {
              // Двойной клик по картинке — редактор изображения (news.js:396).
              const img = (e.target as HTMLElement).closest('img');
              if (img) {
                e.preventDefault();
                setEditImg(img);
              }
            }}
            onInput={() => { if (activeImg.current) setActiveImg(null); }}
          />

          <p className="text-[12px] text-gray-400 -mt-2">
            Двойной клик по картинке — поворот, обрезка и размер.
          </p>

          {/* Прикреплённое голосование */}
          {poll && (
            <div className="flex items-center gap-3 border border-blue-100 bg-blue-50/50 rounded-xl px-4 py-3">
              <Vote size={18} className="text-[#2563eb] shrink-0" />
              <div className="flex-1 min-w-0 text-sm text-slate-700 truncate">
                <span className="font-bold">Голосование:</span> {poll.question}{' '}
                <span className="text-gray-400">({poll.options.length} вар.)</span>
              </div>
              <button
                type="button"
                title="Изменить"
                onClick={() => setPollOpen(true)}
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-white transition"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                title="Убрать"
                onClick={() => setPoll(null)}
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-white transition"
              >
                <X size={16} />
              </button>
            </div>
          )}

          {status && (
            <p className={`text-[13px] font-medium ${status.err ? 'text-red-500' : 'text-gray-500'}`}>
              {status.text}
            </p>
          )}
        </div>

        {/* Подвал */}
        <div className="flex flex-wrap items-center gap-4 px-6 py-4 border-t border-gray-100">
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="w-4 h-4 accent-[#2563eb]"
            />
            <Pin size={14} className="text-gray-400" /> Закрепить сверху
          </label>
          <div className="ml-auto flex gap-2">
            <SecondaryButton onClick={onClose}>Отмена</SecondaryButton>
            <PrimaryButton onClick={save} disabled={saving}>
              {post ? 'Сохранить' : 'Опубликовать'}
            </PrimaryButton>
          </div>
        </div>

        {/* Скрытые file-инпуты */}
        <input ref={imgFileRef} type="file" accept="image/*" hidden onChange={onImgPicked} />
        <input ref={docFileRef} type="file" hidden onChange={onDocPicked} />
      </div>

      {pollOpen && (
        <PollModal
          initial={poll}
          onCancel={() => setPollOpen(false)}
          onSave={(p) => { setPoll(p); setPollOpen(false); }}
        />
      )}

      {editImg && (
        <NewsImageEditor
          src={editImg.src}
          onCancel={() => setEditImg(null)}
          onApply={(url, width) => {
            // Подменяем картинку в теле поста: ширина по горизонтали, высота — авто.
            editImg.src = url;
            editImg.setAttribute('width', String(width));
            editImg.removeAttribute('height');
            setEditImg(null);
          }}
        />
      )}
    </div>
  );
}
