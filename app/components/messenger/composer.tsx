'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { BarChart3, Bot, FileText, Loader2, MessageSquare, Paperclip, Send, X } from 'lucide-react';
import { apiPost, apiUpload } from '@/lib/api';
import { useKeyboardInset } from '@/lib/viewport';
import { PollCreateModal } from './poll';
import type { ActiveConv, Msg, MsgAttachment, PollPayload } from './types';
import { messageText } from './types';

// Поле ввода мессенджера: текст, вложения (скрепка / drag-and-drop / Ctrl+V),
// ответ на сообщение, голосования и режим «Спросить ИИ».
// Загрузка файлов — POST /api/messenger/upload (поле формы `file`, по одному).

const MAX_FILES = 10;      // бэкенд не ограничивает, но легаси держит 10
const MAX_TEXTAREA = 140;  // авто-высота поля ввода
const TYPING_THROTTLE = 2500;
const TYPING_STOP = 3500;

export function Composer({
  conv,
  reply,
  onCancelReply,
  onSend,
  onAsk,
  onPoll,
  rootRef,
}: {
  conv: ActiveConv;
  reply: Msg | null;
  onCancelReply: () => void;
  onSend: (content: string, atts: MsgAttachment[]) => void;
  onAsk: (content: string) => void;
  onPoll: (payload: PollPayload) => void;
  /** Корневой узел композера — нужен треду для отступа ленты. */
  rootRef?: RefObject<HTMLDivElement | null>;
}) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<MsgAttachment[]>([]);
  const [aiMode, setAiMode] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [error, setError] = useState('');

  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ownRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragDepth = useRef(0);

  // Поднимаем поле ввода из-под экранной клавиатуры (только сенсорные экраны).
  const boxRef = rootRef ?? ownRef;
  useKeyboardInset(boxRef);

  // Авто-высота поля ввода.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA)}px`;
  }, [text]);

  // ── сигнал «печатает» (HTTP, debounce как в легаси) ───────────────────────
  const pingTyping = (typing: boolean) => {
    if (conv.notes) return; // в «Заметках» некому показывать
    const body = conv.general
      ? { general: true, typing }
      : { peer_id: conv.peerId, typing };
    apiPost('/api/messenger/typing', body).catch(() => {});
  };

  const stopTyping = () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    if (lastTyping.current) {
      lastTyping.current = 0;
      pingTyping(false);
    }
  };

  const changeText = (v: string) => {
    setText(v);
    if (conv.notes) return;
    if (!v) {
      stopTyping();
      return;
    }
    const now = Date.now();
    if (now - lastTyping.current > TYPING_THROTTLE) {
      lastTyping.current = now;
      pingTyping(true);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      lastTyping.current = 0;
      pingTyping(false);
    }, TYPING_STOP);
  };

  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);

  // ── вложения ──────────────────────────────────────────────────────────────
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setError('');
    setUploading(true);
    const added: MsgAttachment[] = [];
    let free = MAX_FILES - atts.length;
    for (const f of files) {
      if (free <= 0) {
        setError(`Не более ${MAX_FILES} вложений в одном сообщении`);
        break;
      }
      const fd = new FormData();
      fd.append('file', f);
      try {
        added.push(await apiUpload<MsgAttachment>('/api/messenger/upload', fd));
        free -= 1;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось загрузить файл');
      }
    }
    if (added.length) setAtts((prev) => [...prev, ...added]);
    setUploading(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files || []));
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  // ── отправка ──────────────────────────────────────────────────────────────
  const submit = () => {
    const t = text.trim();
    if (uploading) return;
    if (aiMode) {
      if (!t) return;
      setText('');
      stopTyping();
      onAsk(t);
      return;
    }
    if (!t && !atts.length) return;
    const sending = atts;
    setText('');
    setAtts([]);
    setError('');
    stopTyping();
    onSend(t, sending);
  };

  return (
    <div
      ref={boxRef}
      className={`relative z-10 p-3 bg-white border-t transition ${
        dragging ? 'border-[#2563eb] bg-blue-50/40' : 'border-gray-50'
      }`}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {/* плашка ответа */}
      {reply && (
        <div className="flex items-center gap-2 mb-2 bg-gray-50 border-l-2 border-[#2563eb] rounded-lg px-2.5 py-1.5">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold text-[#2563eb]">
              Ответ · {reply.mine ? 'вам' : reply.sender_name}
            </p>
            <p className="text-[11px] text-gray-500 truncate">{messageText(reply)}</p>
          </div>
          <button
            onClick={onCancelReply}
            className="p-1 text-gray-300 hover:text-gray-500 transition shrink-0"
            title="Отменить ответ"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* чипы вложений */}
      {atts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {atts.map((a, i) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 bg-blue-50/60 border border-blue-100 rounded-lg pl-2 pr-1 py-1 text-[11px] font-medium text-slate-600 max-w-[220px]"
            >
              <FileText size={12} className="text-[#2563eb] shrink-0" />
              <span className="truncate">{a.name}</span>
              <button
                onClick={() => setAtts((prev) => prev.filter((_, j) => j !== i))}
                className="p-0.5 text-gray-300 hover:text-red-500 transition shrink-0"
                title="Убрать"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="text-[11px] font-semibold text-red-500 mb-2">{error}</p>}

      <div className="flex items-end gap-1.5 bg-gray-50 p-1.5 rounded-xl border border-gray-200 focus-within:border-[#2563eb] focus-within:bg-white transition">
        <input
          type="file"
          ref={fileRef}
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="p-2 rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-white transition disabled:opacity-50 shrink-0"
          title="Прикрепить файл"
        >
          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
        </button>

        {conv.general && (
          <button
            onClick={() => setPollOpen(true)}
            className="p-2 rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-white transition shrink-0"
            title="Начать голосование"
          >
            <BarChart3 size={16} />
          </button>
        )}

        <button
          onClick={() => setAiMode((v) => !v)}
          className={`p-2 rounded-lg transition shrink-0 ${
            aiMode ? 'bg-[#2563eb] text-white' : 'text-gray-400 hover:text-[#2563eb] hover:bg-white'
          }`}
          title={aiMode ? 'Обычное сообщение' : 'Спросить ИИ'}
        >
          {aiMode ? <Bot size={16} /> : <MessageSquare size={16} />}
        </button>

        <textarea
          ref={areaRef}
          value={text}
          rows={1}
          onChange={(e) => changeText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={aiMode ? 'Спросить ИИ…' : 'Сообщение'}
          className="flex-1 bg-transparent px-2 py-2 text-sm text-slate-700 focus:outline-none placeholder-gray-300 resize-none max-h-[140px]"
        />

        <button
          onClick={submit}
          disabled={uploading || (!text.trim() && !atts.length)}
          className="bg-[#2563eb] text-white p-2.5 rounded-lg transition shadow-md shadow-blue-100 shrink-0 hover:bg-[#1e40af] disabled:opacity-50 disabled:shadow-none"
          title="Отправить"
        >
          <Send size={16} />
        </button>
      </div>

      <p className="text-[10px] text-gray-400 mt-1.5 px-1">
        Enter — отправить, Shift+Enter — перенос строки. Файлы можно перетащить сюда или вставить
        из буфера.
      </p>

      {pollOpen && (
        <PollCreateModal
          onClose={() => setPollOpen(false)}
          onCreate={(payload) => {
            setPollOpen(false);
            onPoll(payload);
          }}
        />
      )}
    </div>
  );
}
