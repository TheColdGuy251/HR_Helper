'use client';

// Типы и утилиты мессенджера. Формы данных сверены с бэкендом:
// HR Helper/routes/messenger.py (_serialize, _serialize_file, _poll_of,
// /conversations, /thread) и легаси messenger_common.js / messenger_page.js.

import type { MessageSource } from '@/lib/msgfmt';

// ─────────── данные с бэкенда ───────────

export interface MsgAttachment {
  id: number;
  name: string;
  size: number;
  is_image: boolean;
  url: string;           // /api/messenger/files/{id}
  download_url: string;  // /api/messenger/files/{id}?download=1
  created_at?: string;
  message_id?: number | null;
  w?: number | null;
  h?: number | null;
}

export interface PollVoter {
  id: number;
  name: string;
  initials: string;
  is_bot?: boolean;
}

export interface PollOptionData {
  id: number;
  text: string;
  votes: number;
  mine: boolean;
  voters: PollVoter[] | null;
}

export interface PollData {
  id: number;
  question: string;
  description: string;
  allow_multiple: boolean;
  show_voters: boolean;
  allow_change: boolean;
  allow_bot: boolean;
  options: PollOptionData[];
  total_votes: number;
  voted: boolean;
}

export interface ReactionData {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface ReplyPreview {
  id: number;
  sender_name: string;
  text: string;
}

export interface ForwardedMeta {
  content?: string;
  sources?: MessageSource[];
  ai?: boolean;
  system?: boolean;
  pii?: boolean;
  attachment?: { id: number; title: string; filename: string } | null;
}

export interface ForwardedFrom {
  id?: number;
  name: string;
  initials: string;
}

/** Клиентское состояние стримингового ответа ИИ (hr:ai-stream). */
export interface AiStreamState {
  status: string;
  text: string;
  sources: MessageSource[];
}

export interface Msg {
  id: number | string; // string — временный id оптимистичного сообщения
  sender_id: number;
  sender_name: string;
  sender_initials: string;
  content: string;
  forwarded: boolean;
  forwarded_meta: ForwardedMeta | null;
  forwarded_from?: ForwardedFrom | null;
  created_at: string;
  mine: boolean;
  self_chat?: boolean;
  peer_key?: string;
  is_general: boolean;
  is_pinned?: boolean;
  is_edited?: boolean;
  is_ai_query?: boolean;
  system?: boolean;
  reply_to?: ReplyPreview | null;
  attachments?: MsgAttachment[];
  status?: 'sending' | 'failed' | 'delivered' | 'seen' | null;
  reactions?: ReactionData[];
  poll?: PollData | null;
  streaming?: AiStreamState | null; // только на клиенте
}

export interface ConvItem {
  key: string;
  peer_id: number | null;
  name: string;
  short_name?: string;
  initials: string;
  position: string;
  unread: number;
  last_text: string;
  last_at: string | null;
  is_notes?: boolean;
  online?: boolean;
}

export interface ConversationsData {
  general: ConvItem | null;
  notes: ConvItem | null;
  users: ConvItem[];
}

export interface ThreadResponse {
  peer_key: string;
  has_more: boolean;
  first_unread_id: number | null;
  unread_count: number;
  messages: Msg[];
}

export interface PresenceInfo {
  online: boolean;
  last_seen: string | null;
}

export interface AttachmentsData {
  media: MsgAttachment[];
  documents: MsgAttachment[];
  links: { url: string; message_id: number }[];
}

export interface PollPayload {
  question: string;
  description: string;
  options: string[];
  allow_multiple: boolean;
  show_voters: boolean;
  allow_change: boolean;
  allow_bot: boolean;
}

/** Активная беседа (выбранная в списке). */
export interface ActiveConv {
  key: string;          // 'general' | String(peer_id)
  peerId: number | null;
  general: boolean;
  notes: boolean;       // «Заметки» — диалог с самим собой
  name: string;
  initials: string;
  position: string;
}

// ─────────── SSE-события (detail) ───────────

export interface TypingEvent {
  peer_key: string;
  sender_id: number;
  sender_name: string;
  sender_initials: string;
  typing: boolean;
}
export interface ReadEvent { peer_key: string; last_read_id: number }
export interface DeletedEvent { peer_key: string; id: number }
export interface PinnedEvent { peer_key: string; id: number; pinned: boolean }
export interface EditedEvent { peer_key: string; id: number; content: string }
export interface ReactionEvent { peer_key: string; id: number; reactions: ReactionData[] }
export interface PollEvent { peer_key: string; id: number; poll: PollData }
export interface PresenceEvent { user_id: number; online: boolean; last_seen?: string | null }
export interface AiStreamEvent {
  id: number;
  peer_key: string;
  asker_id: number;
  phase: 'queued' | 'start' | 'status' | 'sources' | 'chunk' | 'done';
  status?: string;
  chunk?: string;
  content?: string;
  sources?: MessageSource[];
  queue_position?: number;
  queue_total?: number;
}

// ─────────── утилиты ───────────

/** Эмодзи ряда реакций — состав и порядок 1-в-1 из легаси
 *  (messenger_common.js:126: `const REACTIONS = ["❤️","🔥","👍","👎","👌","😢","🤯"]`).
 *  Первые 4 видны сразу, остальные 3 — под стрелкой (см. ReactionRow). */
export const REACTION_EMOJIS = ['❤️', '🔥', '👍', '👎', '👌', '😢', '🤯'];

/** Совпадает ли поисковый запрос со строкой «HR-ассистент».
 *  Порт условия из легаси (messenger_page.js:141, messenger.js:450):
 *  `if (!term || "hr-ассистент ассистент ии бот".indexOf(term) >= 0)`. */
const ASSISTANT_TERMS = 'hr-ассистент ассистент ии бот';

export function matchesAssistant(q: string): boolean {
  const term = (q || '').trim().toLowerCase();
  return !term || ASSISTANT_TERMS.includes(term);
}

export function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m = Math.abs(n) % 100;
  const m1 = m % 10;
  if (m > 10 && m < 20) return many;
  if (m1 > 1 && m1 < 5) return few;
  if (m1 === 1) return one;
  return many;
}

/** Ключ дня для разделителей дат. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** «Сегодня» / «Вчера» / «5 марта» / «5 марта 2024». */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('ru-RU', opts);
}

/** «был(а) только что / N минут назад / вчера / дата» (порт lastSeenText). */
export function lastSeenText(iso: string | null | undefined): string {
  if (!iso) return 'не в сети';
  const d = new Date(iso);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 50) return 'был(а) только что';
  const min = Math.floor(sec / 60);
  if (min < 60) return `был(а) ${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `был(а) ${hr} ${plural(hr, 'час', 'часа', 'часов')} назад`;
  const days = Math.floor(hr / 24);
  if (days === 1) return 'был(а) вчера';
  if (days < 7) return `был(а) ${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return `был(а) ${d.toLocaleDateString('ru-RU')}`;
}

/** «X печатает» / «X, Y и другие печатают». */
export function typingLabel(names: string[]): string {
  const list = names.filter(Boolean);
  if (!list.length) return '';
  const verb = list.length === 1 ? 'печатает' : 'печатают';
  if (list.length <= 3) return `${list.join(', ')} ${verb}`;
  return `${list.slice(0, 3).join(', ')} и другие печатают`;
}

/** Текст сообщения для копирования/превью ответа. */
export function messageText(m: Msg): string {
  if (m.forwarded && m.forwarded_meta) {
    return (m.content ? m.content + '\n\n' : '') + (m.forwarded_meta.content || '');
  }
  let t = m.content || '';
  if (m.attachments && m.attachments.length) {
    t += (t ? '\n' : '') + m.attachments.map((a) => '📎 ' + a.name).join('\n');
  }
  return t;
}

/** Копирование нескольких сообщений: подряд идущие от одного автора — под его
 *  именем, смена автора — новая группа, группы через пустую строку. */
export function groupedCopyText(msgs: Msg[]): string {
  const groups: { name: string; lines: string[] }[] = [];
  (msgs || []).forEach((m) => {
    const text = (messageText(m) || '').trim();
    if (!text) return;
    const name = m.sender_name || (m.mine ? 'Вы' : 'Отправитель');
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.lines.push(text);
    else groups.push({ name, lines: [text] });
  });
  return groups.map((g) => `${g.name}:\n${g.lines.join('\n')}`).join('\n\n');
}

const GAP_MS = 10 * 60 * 1000; // порог группировки — 10 минут

/** Флаги группировки подряд идущих сообщений одного автора (порт groupFlag). */
export function groupFlag(prev: Msg | undefined, m: Msg): { grouped: boolean; gap: boolean } {
  if (!prev || prev.system || m.system) return { grouped: false, gap: false };
  const dt = new Date(m.created_at).getTime() - new Date(prev.created_at).getTime();
  const same = prev.sender_id === m.sender_id && !prev.forwarded && !m.forwarded;
  if (dt > GAP_MS) return { grouped: false, gap: true };
  return { grouped: same, gap: false };
}

/** Статусы генерации ответа ИИ (порт AI_STATUS из messenger_common.js). */
const AI_STATUS: Record<string, string> = {
  search: 'Ищу в базе знаний…',
  rerank: 'Подбираю релевантные фрагменты…',
  rerank_done: 'Готовлю ответ…',
  generate: 'Формулирую ответ…',
  intent: 'Анализирую запрос…',
  extract_fields: 'Разбираю данные…',
  plan: 'Планирую поиск…',
};

export function aiStatusLabel(s?: string): string {
  return (s && AI_STATUS[s]) || 'Готовлю ответ…';
}

export function aiQueueLabel(pos?: number, total?: number): string {
  if (!pos || pos <= 1) return 'Вы следующий в очереди…';
  return `Вы ${pos}-й в очереди${total ? ` из ${total}` : ''}…`;
}

export function copyText(text: string): void {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch {
    /* буфер недоступен */
  }
}

/** Инициалы из ФИО (для восстановления беседы без полного объекта). */
export function initialsOf(name: string | undefined): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

/** Вставка сообщения с сохранением порядка по числовому id (без дублей). */
export function insertOrdered(list: Msg[], m: Msg): Msg[] {
  if (list.some((x) => String(x.id) === String(m.id))) return list;
  const idNum = typeof m.id === 'number' ? m.id : NaN;
  if (!Number.isNaN(idNum)) {
    const idx = list.findIndex((x) => typeof x.id === 'number' && x.id > idNum);
    if (idx >= 0) {
      const next = list.slice();
      next.splice(idx, 0, m);
      return next;
    }
  }
  return [...list, m];
}
