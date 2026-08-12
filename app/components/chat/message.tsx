'use client';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Forward,
  Info,
  MoreVertical,
  Paperclip,
  Pencil,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import {
  escapeAttr,
  escapeHtml,
  formatMessageContent,
  renderAttachmentCard,
  type MessageAttachment,
  type MessageSource,
} from '@/lib/msgfmt';

// ── Типы сообщений чата (формы см. routes/chat.py: _message_item) ────────────

export interface UserAttachment {
  id: number;
  name: string;
}

export interface RelatedFile {
  kind?: string;
  title?: string;
  url?: string;
  view_url?: string;
}

/** Уточняющий вопрос FAQ: чипы-варианты под ответом (порт renderClarifyChips). */
export interface ClarifyMeta {
  question?: string;
  options?: (string | { text?: string; label?: string; value?: string })[];
}

export interface ChatMeta {
  contact?: string;
  related_files?: RelatedFile[];
  pii_doc?: boolean;
  clarify?: ClarifyMeta;
  [k: string]: unknown;
}

/** Состояние выделения пузыря (тулбар живёт на странице чата). */
export interface ChatSelection {
  mode: boolean;
  checked: boolean;
}

export interface FactCheck {
  supported?: number;
  total?: number;
}

export interface ChatMsg {
  id: number | string; // string — временный клиентский id до ответа сервера
  role: 'user' | 'assistant';
  content: string;
  is_read?: boolean;
  is_finished?: boolean;
  ts?: string | null;
  sources?: MessageSource[] | null;
  meta?: ChatMeta | null;
  fact_check?: FactCheck | null;
  attachment?: MessageAttachment | null;
  user_attachments?: UserAttachment[] | null;
  user_rating?: number;
  variant_index?: number;
  variant_count?: number;
  // Клиентские поля стрима
  streaming?: boolean;
  status?: string;
  queue_position?: number;
  queue_total?: number;
}

// ── Статусы генерации (SSE-кадры {status}) ──────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  queued: 'Ожидание в очереди…',
  search: 'Поиск по базе знаний…',
  rerank: 'Анализ найденного…',
  rerank_done: 'Готовлю ответ…',
  generate: 'Генерация ответа…',
  intent: 'Определяю тип запроса…',
  extract_fields: 'Разбираю данные…',
  render_doc: 'Формирую документ…',
};

export function statusLabel(status?: string, pos?: number, total?: number): string {
  if (status === 'queued') {
    if (!pos || pos <= 1) return 'Вы следующий в очереди…';
    return `Вы ${pos}-й в очереди${total ? ` из ${total}` : ''}…`;
  }
  return STATUS_LABELS[status || ''] || 'Обработка…';
}

// Время сообщения: сегодня → «HH:MM», раньше → «DD.MM.YYYY HH:MM».
export function formatMsgTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hm : `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${hm}`;
}

// ── Связанные бланки/документы FAQ (meta.related_files) как HTML-карточки ────

const SVG_FILE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const SVG_DOWNLOAD =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
const SVG_PAPERCLIP =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

function relatedFilesHtml(meta?: ChatMeta | null): string {
  const files = meta?.related_files;
  if (!files || !files.length) return '';
  const cards = files
    .map((f) => {
      const view = f.view_url || f.url || '';
      if (!view) return '';
      const kindLabel =
        f.kind === 'template'
          ? 'бланк — открыть/скачать'
          : f.kind === 'link'
            ? 'страница на сайте — открыть'
            : 'документ — открыть/скачать';
      return (
        `<div class="chat-attachment">` +
        `<a class="chat-attachment-main" href="${escapeAttr(view)}" target="_blank" rel="noopener" title="Открыть">` +
        `<div class="chat-attachment-icon">${SVG_FILE}</div>` +
        `<div class="chat-attachment-body"><div class="chat-attachment-title">${escapeHtml(f.title || 'Документ')}</div>` +
        `<div class="chat-attachment-name">${kindLabel}</div></div></a>` +
        (f.url
          ? `<a class="chat-attachment-action" href="${escapeAttr(f.url)}" title="Скачать" aria-label="Скачать">${SVG_DOWNLOAD}</a>`
          : '') +
        `</div>`
      );
    })
    .filter(Boolean)
    .join('');
  // Шапка со скрепкой — как в renderRelatedFiles (chat.js:1358).
  return cards
    ? `<div class="chat-related-files"><div class="chat-related-title">${SVG_PAPERCLIP} Бланки и документы</div>${cards}</div>`
    : '';
}

// ── Контакт подразделения со ссылками ───────────────────────────────────────
// Импорт FAQ превращает пометку «(ссылка на телефонный справочник)» в
// markdown-ссылку [Отдел …](https://www.tyuiu.ru/phones/) — рендерим её
// кликабельной. Прочий текст остаётся как есть.

const CONTACT_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

function contactNodes(contact: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  CONTACT_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONTACT_LINK_RE.exec(contact))) {
    if (m.index > last) out.push(contact.slice(last, m.index));
    out.push(
      <a
        key={m.index}
        href={m[2]}
        target="_blank"
        rel="noopener"
        className="text-[#2563eb] underline underline-offset-2 hover:text-[#1e40af]"
      >
        {m[1]}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < contact.length) out.push(contact.slice(last));
  return out;
}

// ── Индикатор «бот думает» ──────────────────────────────────────────────────

function Thinking({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-gray-400 text-sm py-0.5">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 bg-[#2563eb] rounded-full animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
      <span>{label}</span>
    </div>
  );
}

// ── Контекстное меню сообщения (как в мессенджере) ──────────────────────────

const LONG_PRESS_MS = 500; // порог долгого нажатия (как в легаси attachThreadInteractions)
const LONG_PRESS_SLOP = 10; // допустимый сдвиг пальца до отмены долгого нажатия
const MENU_W = 230;
const MENU_H = 260;

/** Пункт контекстного меню — оформление то же, что в components/messenger/message.tsx. */
function MenuItem({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-semibold transition text-left text-slate-600 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}

// ── Пузырь сообщения ────────────────────────────────────────────────────────

export function MessageBubble({
  msg,
  busy,
  selection,
  onFeedback,
  onVariant,
  onEdit,
  onRetry,
  onForward,
  onStartSelect,
  onToggleSelect,
  onClarify,
}: {
  msg: ChatMsg;
  busy: boolean; // идёт стрим — блокируем действия
  selection: ChatSelection;
  onFeedback: (id: number, rating: number) => void;
  onVariant: (id: number, dir: number) => void;
  onEdit: (id: number, text: string) => void;
  onRetry: (id: number) => void;
  onForward: (m: ChatMsg) => void;
  onStartSelect: (m: ChatMsg) => void;
  onToggleSelect: (id: ChatMsg['id']) => void;
  onClarify: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [copied, setCopied] = useState(false);
  const pressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const isUser = msg.role === 'user';
  const numId = typeof msg.id === 'number' ? msg.id : null;
  const rating = Number(msg.user_rating || 0);
  const selMode = selection.mode;

  // ── вход в режим выделения: правый клик / долгое нажатие ──────────────────
  const cancelPress = () => {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  };

  const selectHandlers = {
    onContextMenu: (e: React.MouseEvent) => {
      if (numId == null) return;
      e.preventDefault();
      if (selMode) onToggleSelect(msg.id);
      else onStartSelect(msg);
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (selMode || numId == null || e.pointerType === 'mouse') return;
      const { clientX: x, clientY: y } = e;
      pressRef.current = {
        x,
        y,
        timer: setTimeout(() => {
          pressRef.current = null;
          onStartSelect(msg);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = pressRef.current;
      if (!p) return;
      if (
        Math.abs(e.clientX - p.x) > LONG_PRESS_SLOP ||
        Math.abs(e.clientY - p.y) > LONG_PRESS_SLOP
      ) {
        cancelPress();
      }
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
  };

  /** Чекбокс слева от пузыря — виден только в режиме выделения. */
  const checkbox = selMode ? (
    <div className="w-5 shrink-0 self-center">
      {numId != null && (
        <span
          className={`w-[18px] h-[18px] rounded-md border flex items-center justify-center transition ${
            selection.checked ? 'bg-[#2563eb] border-[#2563eb] text-white' : 'bg-white border-gray-300'
          }`}
        >
          {selection.checked && <Check size={12} />}
        </span>
      )}
    </div>
  ) : null;

  const rowProps = {
    onClick: selMode && numId != null ? () => onToggleSelect(msg.id) : undefined,
    className: selMode ? 'cursor-pointer select-none rounded-xl transition-colors' : '',
  };

  // HTML контента ассистента: markdown + источники (блок — только после стрима)
  const html = useMemo(() => {
    if (isUser) return '';
    let h = formatMessageContent(msg.content, msg.sources || null, !msg.streaming);
    if (msg.attachment) h += renderAttachmentCard(msg.attachment);
    h += relatedFilesHtml(msg.meta);
    return h;
  }, [isUser, msg.content, msg.sources, msg.streaming, msg.attachment, msg.meta]);

  // Копирование ответа: пишем и text/html, и text/plain (в Word/почту попадает
  // форматирование), с фолбэком на execCommand для незащищённого http.
  const copy = async () => {
    const text = msg.content || '';
    const rich = bubbleRef.current?.querySelector('.msg-md')?.innerHTML || '';
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    };
    try {
      if (rich && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([rich], { type: 'text/html' }),
            'text/plain': new Blob([text], { type: 'text/plain' }),
          }),
        ]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('clipboard unavailable');
      }
      done();
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch {
        /* буфер недоступен */
      }
    }
  };

  // Навигация по вариантам ‹ i/n › (правки вопроса / ретраи ответа)
  const variantNav =
    (msg.variant_count || 1) > 1 && numId != null ? (
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          disabled={busy || (msg.variant_index || 1) <= 1}
          onClick={() => onVariant(numId, -1)}
          className="p-1 rounded-md hover:bg-gray-100 hover:text-slate-600 disabled:opacity-40 transition"
          title="Предыдущий вариант"
        >
          <ChevronLeft size={13} />
        </button>
        <span className="text-[11px] font-semibold tabular-nums">
          {msg.variant_index || 1}/{msg.variant_count}
        </span>
        <button
          type="button"
          disabled={busy || (msg.variant_index || 1) >= (msg.variant_count || 1)}
          onClick={() => onVariant(numId, 1)}
          className="p-1 rounded-md hover:bg-gray-100 hover:text-slate-600 disabled:opacity-40 transition"
          title="Следующий вариант"
        >
          <ChevronRight size={13} />
        </button>
      </span>
    ) : null;

  // ── Сообщение пользователя ────────────────────────────────────────────────
  if (isUser) {
    const startEdit = () => {
      setEditText(msg.content);
      setEditing(true);
    };
    const submitEdit = () => {
      const t = editText.trim();
      if (!t || numId == null) return;
      setEditing(false);
      onEdit(numId, t);
    };
    return (
      <div
        data-message-id={String(msg.id)}
        data-role={msg.role}
        onClick={rowProps.onClick}
        {...selectHandlers}
        className={`flex justify-end gap-2 ${rowProps.className} ${
          selection.checked ? 'bg-blue-100/60' : ''
        }`}
      >
        {checkbox}
        {/* w-fit — чтобы короткое сообщение не оказалось уже строки действий
            под ним (пузырь ниже получает min-w-full). */}
        <div className="max-w-[88%] md:max-w-xl w-fit flex flex-col items-end gap-1 min-w-0">
          {editing ? (
            <div className="w-[80vw] max-w-lg bg-white border border-gray-200 rounded-2xl p-3 shadow-sm">
              <textarea
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submitEdit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditing(false);
                  }
                }}
                rows={3}
                className="w-full text-sm text-slate-700 bg-gray-50 border border-gray-200 rounded-xl p-3 focus:outline-none focus:border-[#2563eb] resize-none"
                aria-label="Изменить сообщение"
              />
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-500 border border-gray-200 hover:bg-gray-50 transition"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={submitEdit}
                  disabled={!editText.trim() || busy}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#2563eb] hover:bg-[#1e40af] transition disabled:opacity-60"
                >
                  Отправить
                </button>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-2xl text-sm max-w-full min-w-full shadow-sm leading-relaxed whitespace-pre-wrap break-words bg-[#0f1c3f] text-white rounded-br-none">
              {msg.content}
              {msg.user_attachments && msg.user_attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {msg.user_attachments.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1 bg-white/10 rounded-lg px-2 py-1 text-[11px] font-medium"
                    >
                      <Paperclip size={11} /> {a.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Порядок как в легаси (chat.js:1047): копировать → изменить →
              переслать → навигация по вариантам → время. Отдельной кнопки
              выделения тут нет — режим включается правым кликом или долгим
              нажатием, как в мессенджере. */}
          {!editing && !selMode && (
            <div className="flex items-center gap-1 px-1 text-gray-400">
              <button
                type="button"
                onClick={copy}
                className="p-1 rounded-md hover:bg-gray-100 hover:text-slate-600 transition"
                title="Копировать сообщение"
              >
                {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
              </button>
              {numId != null && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={startEdit}
                  className="p-1 rounded-md hover:bg-gray-100 hover:text-slate-600 disabled:opacity-40 transition"
                  title="Изменить сообщение"
                >
                  <Pencil size={12} />
                </button>
              )}
              <button
                type="button"
                onClick={() => onForward(msg)}
                className="p-1 rounded-md hover:bg-gray-100 hover:text-slate-600 transition"
                title="Переслать коллеге"
              >
                <Forward size={12} />
              </button>
              {variantNav}
              {msg.ts && <span className="text-[11px] ml-0.5">{formatMsgTime(msg.ts)}</span>}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Сообщение ассистента ──────────────────────────────────────────────────
  const fc = msg.fact_check;
  const showNote = !!msg.is_finished && !msg.streaming && !!((msg.sources && msg.sources.length) || msg.meta?.contact);

  // Варианты уточняющего вопроса могут прийти строками или объектами.
  const clarifyOptions = (msg.meta?.clarify?.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.text || o?.label || o?.value || ''))
    .filter(Boolean);

  return (
    <div
      data-message-id={String(msg.id)}
      data-role={msg.role}
      onClick={rowProps.onClick}
      {...selectHandlers}
      className={`flex justify-start gap-2 ${rowProps.className} ${
        selection.checked ? 'bg-blue-100/60' : ''
      }`}
    >
      {checkbox}
      {/* w-fit + min-w-full у пузыря: колонка получает ширину самого широкого
          своего элемента, поэтому под коротким ответом («да», «готово») пузырь
          дотягивается до ряда кнопок, а не оказывается уже него. */}
      <div className="max-w-[92%] md:max-w-2xl w-fit flex flex-col gap-1 min-w-0">
        <div
          ref={bubbleRef}
          className={`p-4 rounded-2xl text-sm shadow-sm leading-relaxed bg-white border border-gray-100 rounded-bl-none text-slate-700 border-l-4 border-l-[#2563eb] min-w-full ${
            selMode ? '[&_a]:pointer-events-none [&_button]:pointer-events-none' : ''
          }`}
        >
          {msg.streaming && !msg.content ? (
            <Thinking label={statusLabel(msg.status, msg.queue_position, msg.queue_total)} />
          ) : (
            <div className="msg-md" dangerouslySetInnerHTML={{ __html: html }} />
          )}

          {/* ПДн: документ и сообщение будут удалены по TTL */}
          {msg.meta?.pii_doc && (
            <div className="mt-3 flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-xl p-2.5 text-[11px] text-amber-700 font-medium">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>
                Документ содержит персональные данные: сообщение и файл будут автоматически удалены
                примерно через час. Скачайте файл сейчас, если он вам нужен.
              </span>
            </div>
          )}

          {/* Пометка о справочном характере + контакт подразделения */}
          {showNote && (
            <div className="mt-3 flex items-start gap-2 bg-blue-50/60 border border-blue-100 rounded-xl p-2.5 text-[11px] text-slate-500 font-medium">
              <Info size={13} className="shrink-0 mt-0.5 text-[#2563eb]" />
              <span>
                Информация носит справочный характер — актуальные положения уточняйте в
                первоисточниках.
                {msg.meta?.contact && (
                  <>
                    {' '}
                    <span className="text-slate-600 font-semibold">
                      Контакт: {contactNodes(msg.meta.contact)}
                    </span>
                  </>
                )}
              </span>
            </div>
          )}

          {/* Уточняющий вопрос FAQ: варианты-чипы (порт renderClarifyChips) */}
          {clarifyOptions.length > 0 && !msg.streaming && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {clarifyOptions.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  disabled={busy}
                  onClick={() => onClarify(opt)}
                  className="px-3 py-1.5 rounded-full border border-blue-100 bg-blue-50/60 text-[11px] font-semibold text-[#2563eb] hover:bg-blue-100 transition disabled:opacity-50"
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>

        {msg.is_finished && !msg.streaming && !selMode && (
          <div className="flex items-center gap-1 px-1 text-gray-400 flex-wrap">
            {/* Порядок как в легаси (chat.js:1124-1135): варианты → копировать →
                нравится → не нравится → другой ответ → переслать → факт-чек →
                время. Кнопки выделения здесь нет: режим включается правым
                кликом или долгим нажатием, как в мессенджере. */}
            {variantNav}
            <button
              type="button"
              onClick={copy}
              className="p-1 rounded-md hover:bg-gray-100 hover:text-slate-600 transition"
              title="Копировать ответ"
            >
              {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
            </button>
            {numId != null && (
              <>
                <button
                  type="button"
                  onClick={() => onFeedback(numId, rating === 1 ? 0 : 1)}
                  className={`p-1 rounded-md hover:bg-gray-100 transition ${
                    rating === 1 ? 'text-[#2563eb]' : 'hover:text-slate-600'
                  }`}
                  title="Хороший ответ"
                >
                  <ThumbsUp size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => onFeedback(numId, rating === -1 ? 0 : -1)}
                  className={`p-1 rounded-md hover:bg-gray-100 transition ${
                    rating === -1 ? 'text-red-500' : 'hover:text-slate-600'
                  }`}
                  title="Плохой ответ"
                >
                  <ThumbsDown size={13} />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRetry(numId)}
                  className="p-1 rounded-md hover:bg-gray-100 hover:text-slate-600 disabled:opacity-40 transition"
                  title="Сгенерировать другой вариант ответа"
                >
                  <RotateCcw size={13} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => onForward(msg)}
              className="p-1 rounded-md hover:bg-gray-100 hover:text-slate-600 transition"
              title="Переслать коллеге"
            >
              <Forward size={13} />
            </button>
            {fc && (fc.total || 0) > 0 && (fc.supported || 0) < (fc.total || 0) && (
              <span
                title={
                  (fc.supported || 0) === 0
                    ? `Ни одно из ${fc.total} утверждений ответа не подтверждается источниками — перепроверьте перед использованием.`
                    : `${fc.supported} из ${fc.total} утверждений подтверждены источниками.`
                }
                className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  (fc.supported || 0) === 0 ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-[#2563eb]'
                }`}
              >
                <AlertTriangle size={10} />
                {(fc.supported || 0) === 0
                  ? `Не подкреплено (0/${fc.total})`
                  : `Частично (${fc.supported}/${fc.total})`}
              </span>
            )}
            {msg.ts && <span className="text-[11px] ml-auto">{formatMsgTime(msg.ts)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
