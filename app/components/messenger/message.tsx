'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerUpLeft,
  Download,
  FileText,
  Forward,
  ListChecks,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  X,
} from 'lucide-react';
import { formatBytes } from '@/lib/api';
import { formatMessageContent } from '@/lib/msgfmt';
import { FilePreviewModal, fileViewUrl, shouldPreview } from './file-preview';
import { PollView } from './poll';
import type { Msg, MsgAttachment } from './types';
import { REACTION_EMOJIS, copyText, fmtTime, messageText } from './types';

// Пузырь сообщения: текст, вложения, цитата ответа, реакции, голосование,
// ответ ИИ (в т.ч. стриминговый) и контекстное меню действий.
// Действия соответствуют HR Helper/routes/messenger.py.

export interface MessageActions {
  onReply: (m: Msg) => void;
  onEdit: (id: number, content: string) => void;
  onDelete: (m: Msg, forAll: boolean) => void;
  onPin: (m: Msg) => void;
  onReact: (id: number, emoji: string) => void;
  onVote: (m: Msg, optionId: number) => void;
  /** «Переслать» — открывает выбор получателя (в т.ч. ассистента), как в легаси. */
  onForward: (m: Msg) => void;
  onJump: (id: number) => void;
  /** Включить режим выделения с этого сообщения (долгое нажатие / меню). */
  onStartSelect: (m: Msg) => void;
  /** Переключить сообщение в наборе выделенных. */
  onToggleSelect: (id: number) => void;
}

/** Состояние выделения для конкретного пузыря. */
export interface MessageSelection {
  mode: boolean;
  checked: boolean;
}

const LONG_PRESS_MS = 500; // порог долгого нажатия (как в легаси attachThreadInteractions)
const LONG_PRESS_SLOP = 10; // допустимый сдвиг пальца до отмены долгого нажатия
// Не более 4 реакций в видимом ряду, 5-я ячейка — стрелка раскрытия
// (messenger_common.js:409, `const MAX = 4`).
const REACTION_ROW_MAX = 4;

// ── Лайтбокс для картинок сообщения ─────────────────────────────────────────

function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: MsgAttachment[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onIndex((index - 1 + items.length) % items.length);
      if (e.key === 'ArrowRight') onIndex((index + 1) % items.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onIndex, onClose]);

  const cur = items[index];
  if (!cur) return null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 flex flex-col items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <a
          href={cur.download_url}
          className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition"
          title="Скачать"
        >
          <Download size={18} />
        </a>
        <button
          onClick={onClose}
          className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition"
          title="Закрыть"
        >
          <X size={18} />
        </button>
      </div>

      {items.length > 1 && (
        <button
          onClick={() => onIndex((index - 1 + items.length) % items.length)}
          className="absolute left-4 p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition"
          title="Предыдущая"
        >
          <ChevronLeft size={20} />
        </button>
      )}
      {items.length > 1 && (
        <button
          onClick={() => onIndex((index + 1) % items.length)}
          className="absolute right-4 p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition"
          title="Следующая"
        >
          <ChevronRight size={20} />
        </button>
      )}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={cur.url}
        alt={cur.name}
        className="max-w-[92vw] max-h-[80vh] object-contain rounded-xl"
      />
      <div className="mt-3 text-xs text-white/70 font-medium">
        {cur.name}
        {items.length > 1 && ` · ${index + 1} / ${items.length}`}
      </div>
    </div>
  );
}

// ── Вложения ────────────────────────────────────────────────────────────────

function Attachments({
  atts,
  onDark,
  onOpenImage,
  onOpenDoc,
}: {
  atts: MsgAttachment[];
  onDark: boolean;
  onOpenImage: (i: number) => void;
  onOpenDoc: (a: MsgAttachment) => void;
}) {
  const images = atts.filter((a) => a.is_image);
  const docs = atts.filter((a) => !a.is_image);

  return (
    <div className="flex flex-col gap-1.5 mt-1.5">
      {images.length > 0 && (
        <div className={`grid gap-1.5 ${images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {images.map((a, i) => (
            <button
              key={a.id}
              onClick={() => onOpenImage(i)}
              className="block overflow-hidden rounded-xl bg-black/5"
              title={a.name}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={a.url}
                alt={a.name}
                loading="lazy"
                className={`w-full object-cover ${images.length === 1 ? 'max-h-64' : 'h-28'}`}
                style={
                  images.length === 1 && a.w && a.h ? { aspectRatio: `${a.w}/${a.h}` } : undefined
                }
              />
            </button>
          ))}
        </div>
      )}

      {docs.map((a) => (
        <div
          key={a.id}
          className={`flex items-center gap-2 rounded-xl p-2 ${
            onDark ? 'bg-white/10' : 'bg-gray-50 border border-gray-100'
          }`}
        >
          <a
            href={fileViewUrl(a)}
            target="_blank"
            rel="noopener"
            title="Открыть предпросмотр"
            onClick={(e) => {
              // Формат с предпросмотром — модалка; остальное уходит по ссылке
              // на страницу-просмотрщик в новой вкладке (как было).
              if (!shouldPreview(e, a)) return;
              e.preventDefault();
              onOpenDoc(a);
            }}
            className="flex items-center gap-2 flex-1 min-w-0"
          >
            <FileText size={16} className={onDark ? 'text-blue-200' : 'text-[#2563eb]'} />
            <span className="flex-1 min-w-0">
              <span className="block text-xs font-semibold truncate">{a.name}</span>
              <span className={`block text-[10px] ${onDark ? 'text-blue-200/70' : 'text-gray-400'}`}>
                {formatBytes(a.size)}
              </span>
            </span>
          </a>
          <a
            href={a.download_url}
            title="Скачать"
            className={`p-1.5 rounded-lg transition shrink-0 ${
              onDark ? 'hover:bg-white/10 text-blue-100' : 'hover:bg-gray-100 text-gray-400'
            }`}
          >
            <Download size={14} />
          </a>
        </div>
      ))}
    </div>
  );
}

// ── Контекстное меню ────────────────────────────────────────────────────────

function MenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-semibold transition text-left ${
        danger ? 'text-red-500 hover:bg-red-50' : 'text-slate-600 hover:bg-gray-50'
      }`}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}

// ── Ряд реакций внутри контекстного меню ────────────────────────────────────
// Легаси (messenger_common.js:407-451): первые 4 эмодзи видны сразу, пятой
// ячейкой стоит стрелка-переключатель, которая раскрывает/сворачивает остальные.

function ReactionRow({
  active,
  onPick,
  onToggle,
}: {
  active: string[];
  onPick: (emoji: string) => void;
  /** Меню могло уехать за нижний край — даём родителю поправить позицию. */
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const head = REACTION_EMOJIS.slice(0, REACTION_ROW_MAX);
  const rest = REACTION_EMOJIS.slice(REACTION_ROW_MAX);

  const emojiBtn = (e: string) => (
    <button
      key={e}
      onClick={() => onPick(e)}
      title={`Реакция ${e}`}
      className={`h-8 rounded-lg text-base flex items-center justify-center transition ${
        active.includes(e) ? 'bg-blue-50 ring-1 ring-[#2563eb]' : 'hover:bg-gray-100'
      }`}
    >
      {e}
    </button>
  );

  return (
    <div className="px-2 py-1.5 border-b border-gray-50">
      <div className="grid grid-cols-5 gap-1">
        {head.map(emojiBtn)}
        {rest.length > 0 && (
          <button
            onClick={() => {
              setOpen((v) => !v);
              onToggle();
            }}
            title={open ? 'Свернуть реакции' : 'Ещё реакции'}
            aria-expanded={open}
            className="h-8 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-[#2563eb] flex items-center justify-center transition"
          >
            <ChevronDown
              size={14}
              className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>

      {rest.length > 0 && (
        <div
          className={`grid transition-[grid-template-rows] duration-200 ${
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          }`}
        >
          <div className="overflow-hidden">
            <div className="grid grid-cols-5 gap-1 pt-1">{rest.map(emojiBtn)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Подтверждение удаления ──────────────────────────────────────────────────
// Порт U.confirmDelete (messenger_common.js:857-883): один пункт «Удалить»
// открывает окно с выбором — «у меня» либо, если все сообщения свои, галочка
// «Удалить для всех».

export function ConfirmDeleteModal({
  count,
  allowForAll,
  onCancel,
  onConfirm,
}: {
  count: number;
  allowForAll: boolean;
  onCancel: () => void;
  onConfirm: (forAll: boolean) => void;
}) {
  const [forAll, setForAll] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const title = allowForAll
    ? count > 1
      ? `Удалить сообщения (${count})?`
      : 'Удалить сообщение?'
    : 'Удалить у меня?';

  return (
    <div
      className="fixed inset-0 z-[110] bg-black/30 flex items-center justify-center p-4"
      // окно живёт внутри пузыря — клики наружу не пускаем
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-xs bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <p className="text-sm font-bold text-[#0f1c3f]">{title}</p>

        {allowForAll ? (
          <label className="flex items-center gap-2 mt-3 text-xs font-semibold text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={forAll}
              onChange={(e) => setForAll(e.target.checked)}
              className="w-4 h-4 accent-[#2563eb]"
            />
            Удалить для всех
          </label>
        ) : (
          <p className="mt-2 text-[11px] text-gray-400">
            Чужие сообщения удаляются только у вас.
          </p>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white text-slate-500 border border-gray-200 hover:bg-gray-50 transition"
          >
            Отмена
          </button>
          <button
            onClick={() => onConfirm(allowForAll && forAll)}
            className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white bg-red-500 hover:bg-red-600 transition"
          >
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Статус доставки своего сообщения ────────────────────────────────────────

function StatusTick({ status }: { status: Msg['status'] }) {
  if (status === 'failed') return <AlertCircle size={12} className="text-red-300" />;
  if (status === 'sending') return <Check size={12} className="opacity-40" />;
  if (status === 'seen') return <CheckCheck size={12} />;
  if (status === 'delivered') return <Check size={12} />;
  return null;
}

// ── Пузырь ──────────────────────────────────────────────────────────────────

export function Message({
  msg,
  general,
  grouped,
  gap,
  hideAvatar,
  highlight,
  selection,
  actions,
}: {
  msg: Msg;
  general: boolean;
  grouped: boolean;
  gap: boolean;
  hideAvatar: boolean;
  highlight: boolean;
  selection: MessageSelection;
  actions: MessageActions;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [docPreview, setDocPreview] = useState<MsgAttachment | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);

  const numId = typeof msg.id === 'number' ? msg.id : null;
  const mine = msg.mine;
  const ai = msg.forwarded && !!msg.forwarded_meta;
  const streaming = msg.streaming;
  const atts = msg.attachments || [];
  const images = useMemo(() => atts.filter((a) => a.is_image), [atts]);

  const html = useMemo(() => {
    if (!ai || streaming) return '';
    const fm = msg.forwarded_meta;
    return formatMessageContent(fm?.content || '', fm?.sources || null, true);
  }, [ai, streaming, msg.forwarded_meta]);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  // ── системная строка («закрепил(а) сообщение») ────────────────────────────
  if (msg.system) {
    return (
      <div data-mid={msg.id} className="flex justify-center my-2">
        <span
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
          className="text-[11px] text-gray-400 bg-white border border-gray-100 rounded-full px-3 py-1"
        >
          {msg.sender_name} {msg.content}
        </span>
        {menu && numId != null && (
          <>
            <div className="fixed inset-0 z-[89]" onMouseDown={() => setMenu(null)} />
            <div
              className="fixed z-[90] w-52 bg-white border border-gray-100 rounded-xl shadow-xl overflow-hidden py-1"
              style={{ left: menu.x, top: menu.y }}
            >
              <MenuItem
                icon={Trash2}
                label="Удалить"
                danger
                onClick={() => {
                  setMenu(null);
                  setConfirmDel(true);
                }}
              />
            </div>
          </>
        )}

        {/* системную строку можно удалить только у себя (allowForAll=false) */}
        {confirmDel && (
          <ConfirmDeleteModal
            count={1}
            allowForAll={false}
            onCancel={() => setConfirmDel(false)}
            onConfirm={() => {
              setConfirmDel(false);
              actions.onDelete(msg, false);
            }}
          />
        )}
      </div>
    );
  }

  const openMenu = (x: number, y: number) => {
    if (numId == null) return;
    const w = 230;
    const h = 340; // ряд реакций свёрнут — меню ниже, чем раньше
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  };

  const canEdit = mine && !ai && !msg.forwarded_from && !msg.poll && numId != null;

  const bubbleCls = ai
    ? 'bg-white border border-gray-100 border-l-4 border-l-[#2563eb] text-slate-700 rounded-2xl'
    : mine
      ? 'bg-[#0f1c3f] text-white rounded-2xl rounded-br-none'
      : 'bg-white border border-gray-100 text-slate-700 rounded-2xl rounded-bl-none';
  const onDark = !ai && mine;
  const muted = onDark ? 'text-blue-200/70' : 'text-gray-400';

  const startEdit = () => {
    setEditText(msg.content);
    setEditing(true);
  };
  const submitEdit = () => {
    const t = editText.trim();
    setEditing(false);
    if (!t || numId == null || t === msg.content) return;
    actions.onEdit(numId, t);
  };

  // ── выделение ─────────────────────────────────────────────────────────────
  const selectable = numId != null;
  const selMode = selection.mode;

  const cancelPress = () => {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  };

  // Долгое нажатие (тач) включает режим выделения — как в легаси.
  const onPointerDown = (e: React.PointerEvent) => {
    if (selMode || !selectable || e.pointerType === 'mouse') return;
    const { clientX: x, clientY: y } = e;
    pressRef.current = {
      x,
      y,
      timer: setTimeout(() => {
        pressRef.current = null;
        actions.onStartSelect(msg);
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pressRef.current;
    if (!p) return;
    if (Math.abs(e.clientX - p.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - p.y) > LONG_PRESS_SLOP) {
      cancelPress();
    }
  };

  return (
    <div
      data-mid={msg.id}
      data-selectable={selectable ? '1' : undefined}
      onClick={selMode && numId != null ? () => actions.onToggleSelect(numId) : undefined}
      className={`flex gap-2 px-1 rounded-xl transition-colors ${
        mine ? 'justify-end' : 'justify-start'
      } ${gap ? 'mt-5' : grouped ? 'mt-0.5' : 'mt-3'} ${
        selection.checked ? 'bg-blue-100/70' : highlight ? 'bg-blue-50/80' : ''
      } ${selMode ? 'cursor-pointer select-none' : ''}`}
    >
      {selMode && (
        <div className="w-5 shrink-0 self-center">
          {selectable && (
            <span
              className={`w-[18px] h-[18px] rounded-md border flex items-center justify-center transition ${
                selection.checked
                  ? 'bg-[#2563eb] border-[#2563eb] text-white'
                  : 'bg-white border-gray-300'
              }`}
            >
              {selection.checked && <Check size={12} />}
            </span>
          )}
        </div>
      )}

      {!mine && (
        <div className="w-8 shrink-0 self-end">
          {!hideAvatar && (
            <div
              className={`w-8 h-8 rounded-xl flex items-center justify-center text-white font-bold text-[10px] ${
                ai ? 'bg-[#2563eb]' : 'bg-[#0f1c3f]'
              }`}
              title={msg.sender_name}
            >
              {ai ? <Bot size={14} /> : msg.sender_initials || '?'}
            </div>
          )}
        </div>
      )}

      <div className={`max-w-[85%] md:max-w-xl min-w-0 flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {general && !mine && !ai && !grouped && (
          <span className="text-[11px] font-semibold text-[#2563eb] px-1 mb-0.5">
            {msg.sender_name}
          </span>
        )}

        <div
          className={`relative group p-3 text-sm shadow-sm leading-relaxed max-w-full min-w-0 ${bubbleCls} ${
            selMode ? '[&_a]:pointer-events-none [&_button]:pointer-events-none' : ''
          }`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onContextMenu={(e) => {
            e.preventDefault();
            if (selMode) {
              if (numId != null) actions.onToggleSelect(numId);
              return;
            }
            openMenu(e.clientX, e.clientY);
          }}
        >
          {/* кнопка меню (десктоп: по наведению) */}
          {numId != null && !selMode && (
            <button
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                openMenu(r.left, r.bottom + 4);
              }}
              className={`absolute -top-2 ${mine ? '-left-2' : '-right-2'} p-1 rounded-lg bg-white border border-gray-100 shadow-sm text-gray-400 opacity-0 group-hover:opacity-100 focus:opacity-100 transition hover:text-[#2563eb]`}
              title="Действия"
            >
              <MoreVertical size={12} />
            </button>
          )}

          {msg.is_pinned && (
            <div className={`flex items-center gap-1 text-[10px] font-semibold mb-1 ${muted}`}>
              <Pin size={10} /> Закреплено
            </div>
          )}

          {msg.is_ai_query && (
            <div className={`flex items-center gap-1 text-[10px] font-semibold mb-1 ${muted}`}>
              <Bot size={10} /> Вопрос ассистенту
            </div>
          )}

          {ai && (
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#2563eb] mb-1.5">
              <Bot size={12} /> HR-ассистент
            </div>
          )}

          {msg.forwarded_from && (
            <div className={`flex items-center gap-1 text-[10px] font-semibold mb-1 ${muted}`}>
              <CornerUpLeft size={10} /> Переслано от {msg.forwarded_from.name}
            </div>
          )}

          {msg.reply_to && (
            <button
              onClick={() => msg.reply_to && actions.onJump(msg.reply_to.id)}
              className={`w-full text-left rounded-lg px-2 py-1 mb-1.5 border-l-2 ${
                onDark ? 'bg-white/10 border-blue-300' : 'bg-gray-50 border-[#2563eb]'
              }`}
            >
              <span className={`block text-[10px] font-bold ${onDark ? 'text-blue-200' : 'text-[#2563eb]'}`}>
                {msg.reply_to.sender_name}
              </span>
              <span className={`block text-[11px] truncate ${muted}`}>{msg.reply_to.text}</span>
            </button>
          )}

          {/* содержимое */}
          {streaming ? (
            streaming.text ? (
              <div className="whitespace-pre-wrap break-words">{streaming.text}</div>
            ) : (
              <div className="flex items-center gap-2.5 text-gray-400 py-0.5">
                <span className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-1.5 h-1.5 bg-[#2563eb] rounded-full animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }}
                    />
                  ))}
                </span>
                <span className="text-xs">{streaming.status}</span>
              </div>
            )
          ) : ai ? (
            <div className="msg-md" dangerouslySetInnerHTML={{ __html: html }} />
          ) : editing ? (
            <div className="w-[70vw] max-w-md">
              <textarea
                ref={editRef}
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
                className="w-full text-sm text-slate-700 bg-white border border-gray-200 rounded-xl p-2 focus:outline-none focus:border-[#2563eb] resize-none"
                aria-label="Изменить сообщение"
              />
              <div className="flex justify-end gap-2 mt-1.5">
                <button
                  onClick={() => setEditing(false)}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white text-slate-500 border border-gray-200 hover:bg-gray-50 transition"
                >
                  Отмена
                </button>
                <button
                  onClick={submitEdit}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-white bg-[#2563eb] hover:bg-[#1e40af] transition"
                >
                  Сохранить
                </button>
              </div>
            </div>
          ) : msg.poll ? (
            <PollView
              poll={msg.poll}
              onDark={onDark}
              onVote={(optionId) => actions.onVote(msg, optionId)}
            />
          ) : (
            msg.content && <div className="whitespace-pre-wrap break-words">{msg.content}</div>
          )}

          {atts.length > 0 && (
            <Attachments
              atts={atts}
              onDark={onDark}
              onOpenImage={(i) => setLightbox(i)}
              onOpenDoc={(a) => setDocPreview(a)}
            />
          )}

          {/* мета: правка, время, галочки */}
          <div className={`flex items-center justify-end gap-1 mt-1 text-[10px] ${muted}`}>
            {msg.is_edited && <span>изм.</span>}
            <span>{fmtTime(msg.created_at)}</span>
            {mine && !ai && <StatusTick status={msg.status} />}
          </div>
        </div>

        {msg.reactions && msg.reactions.length > 0 && numId != null && (
          <div className={`flex flex-wrap gap-1 mt-1 px-1 ${selMode ? 'pointer-events-none' : ''}`}>
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => actions.onReact(numId, r.emoji)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[11px] font-semibold transition ${
                  r.mine
                    ? 'bg-blue-50 border-[#2563eb] text-[#2563eb]'
                    : 'bg-white border-gray-100 text-slate-500 hover:border-gray-200'
                }`}
              >
                <span>{r.emoji}</span>
                <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {msg.status === 'failed' && (
          <span className="text-[10px] font-semibold text-red-500 px-1 mt-0.5">Не отправлено</span>
        )}
      </div>

      {lightbox !== null && images.length > 0 && (
        <Lightbox
          items={images}
          index={Math.min(lightbox, images.length - 1)}
          onIndex={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}

      {docPreview && (
        <FilePreviewModal att={docPreview} onClose={() => setDocPreview(null)} />
      )}

      {menu && numId != null && (
        <>
          <div className="fixed inset-0 z-[89]" onMouseDown={() => setMenu(null)} />
          {/* Порядок пунктов — как в легаси menuItems (messenger_page.js:513-526):
              Ответить · Изменить · Закрепить · Копировать · Переслать · —
              Выделить · Удалить. Отдельного пункта для ассистента нет: он
              выбирается получателем внутри окна пересылки (ForwardModal). */}
          <div
            ref={menuRef}
            className="fixed z-[90] w-[230px] bg-white border border-gray-100 rounded-xl shadow-xl overflow-hidden py-1"
            style={{ left: menu.x, top: menu.y }}
          >
            <ReactionRow
              active={(msg.reactions || []).filter((r) => r.mine).map((r) => r.emoji)}
              onPick={(e) => {
                setMenu(null);
                actions.onReact(numId, e);
              }}
              onToggle={() => {
                // Раскрытый ряд мог утопить меню за нижний край окна —
                // подтягиваем его вверх (messenger_common.js:440-443).
                requestAnimationFrame(() => {
                  const el = menuRef.current;
                  if (!el) return;
                  const r = el.getBoundingClientRect();
                  if (r.bottom <= window.innerHeight) return;
                  setMenu((m) =>
                    m ? { ...m, y: Math.max(8, window.innerHeight - r.height - 8) } : m
                  );
                });
              }}
            />
            <MenuItem
              icon={CornerUpLeft}
              label="Ответить"
              onClick={() => {
                setMenu(null);
                actions.onReply(msg);
              }}
            />
            {canEdit && (
              <MenuItem
                icon={Pencil}
                label="Изменить"
                onClick={() => {
                  setMenu(null);
                  startEdit();
                }}
              />
            )}
            <MenuItem
              icon={msg.is_pinned ? PinOff : Pin}
              label={msg.is_pinned ? 'Открепить' : 'Закрепить'}
              onClick={() => {
                setMenu(null);
                actions.onPin(msg);
              }}
            />
            <MenuItem
              icon={Copy}
              label="Копировать"
              onClick={() => {
                setMenu(null);
                copyText(messageText(msg));
              }}
            />
            <MenuItem
              icon={Forward}
              label="Переслать"
              onClick={() => {
                setMenu(null);
                actions.onForward(msg);
              }}
            />
            <div className="border-t border-gray-50 my-1" />
            <MenuItem
              icon={ListChecks}
              label="Выделить"
              onClick={() => {
                setMenu(null);
                actions.onStartSelect(msg);
              }}
            />
            <MenuItem
              icon={Trash2}
              label="Удалить"
              danger
              onClick={() => {
                setMenu(null);
                setConfirmDel(true);
              }}
            />
          </div>
        </>
      )}

      {/* «Удалить для всех» доступно, только если сообщение своё (legacy allMine) */}
      {confirmDel && (
        <ConfirmDeleteModal
          count={1}
          allowForAll={mine}
          onCancel={() => setConfirmDel(false)}
          onConfirm={(forAll) => {
            setConfirmDel(false);
            actions.onDelete(msg, forAll);
          }}
        />
      )}
    </div>
  );
}
