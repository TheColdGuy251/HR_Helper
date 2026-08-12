'use client';
import { useEffect, useState } from 'react';
import { BarChart3, CheckCircle2, Circle, Plus, X } from 'lucide-react';
import type { PollData, PollVoter, PollPayload } from './types';
import { plural } from './types';

// Голосования мессенджера: карточка в сообщении + модалки результатов и создания.
// Формы данных — по HR Helper/routes/messenger.py (/poll, /poll/vote, _poll_of).

/** «N голос/голоса/голосов». */
function votesLabel(n: number): string {
  return `${n} ${plural(n, 'голос', 'голоса', 'голосов')}`;
}

/** Аватар проголосовавшего — инициалы в кружке (порт voterAvatar). */
function VoterAvatar({
  voter,
  onDark = false,
  small = false,
}: {
  voter: PollVoter;
  onDark?: boolean;
  small?: boolean;
}) {
  return (
    <span
      title={voter.name}
      className={`shrink-0 rounded-full font-bold flex items-center justify-center ${
        small ? 'w-[18px] h-[18px] text-[9px]' : 'w-6 h-6 text-[10px]'
      } ${
        voter.is_bot
          ? 'bg-violet-100 text-violet-600'
          : onDark
            ? 'bg-white/20 text-white'
            : 'bg-blue-100 text-[#2563eb]'
      }`}
    >
      {voter.initials || '?'}
    </span>
  );
}

/** Модалка результатов: кто за что проголосовал (порт pollResultsModal). */
export function PollResultsModal({ poll, onClose }: { poll: PollData; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[95] bg-black/30 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // Модалка живёт внутри пузыря сообщения — гасим всплытие, чтобы клики
      // не запускали долгое нажатие/контекстное меню сообщения.
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="bg-white border border-gray-100 rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b border-gray-50 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-bold text-sm text-[#0f1c3f]">
              <BarChart3 size={16} className="text-[#2563eb] shrink-0" />
              <span className="break-words">{poll.question}</span>
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">{votesLabel(poll.total_votes)}</div>
          </div>
          <button
            onClick={onClose}
            title="Закрыть"
            className="p-1 text-gray-300 hover:text-gray-500 transition shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {poll.options.map((o) => {
            const pct = poll.total_votes ? Math.round((o.votes / poll.total_votes) * 100) : 0;
            const voters = o.voters || [];
            return (
              <div key={o.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-700 break-words">{o.text}</span>
                  <span className="text-[11px] text-gray-400 shrink-0">
                    {votesLabel(o.votes)} · {pct}%
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full overflow-hidden bg-gray-200">
                  <div className="h-full rounded-full bg-[#2563eb]" style={{ width: `${pct}%` }} />
                </div>
                {poll.show_voters &&
                  (voters.length ? (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {voters.map((v) => (
                        <div key={v.id} className="flex items-center gap-2">
                          <VoterAvatar voter={v} />
                          <span className="text-xs text-slate-600 truncate">{v.name}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 text-[11px] text-gray-400">Никто не выбрал</div>
                  ))}
              </div>
            );
          })}
          {!poll.show_voters && (
            <div className="text-[11px] text-gray-400 text-center">
              Голосование анонимное — показаны только числа.
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-200 text-slate-600 hover:bg-gray-50 transition"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

/** Карточка голосования внутри пузыря. onDark — внутри тёмного «своего» пузыря. */
export function PollView({
  poll,
  onDark,
  onVote,
}: {
  poll: PollData;
  onDark: boolean;
  onVote: (optionId: number) => void;
}) {
  const [showResults, setShowResults] = useState(false);
  const sub = [votesLabel(poll.total_votes)];
  if (poll.allow_multiple) sub.push('неск. ответов');
  if (poll.show_voters) sub.push('открытое');

  const mutedText = onDark ? 'text-blue-200/70' : 'text-gray-400';
  const barBg = onDark ? 'bg-white/15' : 'bg-gray-100';
  const barFill = onDark ? 'bg-white/80' : 'bg-[#2563eb]';

  return (
    <div className="min-w-[220px] max-w-full">
      <div className="font-semibold text-sm">{poll.question}</div>
      {poll.description && <div className={`text-xs mt-0.5 ${mutedText}`}>{poll.description}</div>}
      <div className="mt-2 flex flex-col gap-1.5">
        {poll.options.map((o) => {
          const pct = poll.total_votes ? Math.round((o.votes / poll.total_votes) * 100) : 0;
          return (
            <button
              key={o.id}
              onClick={() => onVote(o.id)}
              className={`text-left rounded-lg px-2 py-1.5 transition ${
                onDark ? 'hover:bg-white/10' : 'hover:bg-blue-50/60'
              }`}
            >
              <div className="flex items-center gap-2 text-xs">
                {o.mine ? (
                  <CheckCircle2 size={14} className={onDark ? 'text-emerald-300' : 'text-[#2563eb]'} />
                ) : (
                  <Circle size={14} className={mutedText} />
                )}
                <span className="flex-1 min-w-0 break-words">{o.text}</span>
                <span className={`shrink-0 ${mutedText}`}>
                  {o.votes} · {pct}%
                </span>
              </div>
              <div className={`mt-1 h-1.5 rounded-full overflow-hidden ${barBg}`}>
                <div className={`h-full rounded-full ${barFill}`} style={{ width: `${pct}%` }} />
              </div>
              {poll.show_voters && o.voters && o.voters.length > 0 && (
                <div className="mt-1 flex items-center gap-0.5">
                  {o.voters.slice(0, 6).map((v) => (
                    <VoterAvatar key={v.id} voter={v} onDark={onDark} small />
                  ))}
                  {o.voters.length > 6 && (
                    <span className={`text-[10px] ${mutedText}`}>+{o.voters.length - 6}</span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className={`mt-1.5 flex items-center justify-between gap-2 text-[11px] ${mutedText}`}>
        <span>{sub.join(' · ')}</span>
        <button
          onClick={() => setShowResults(true)}
          className="font-semibold hover:underline shrink-0"
        >
          Результаты
        </button>
      </div>
      {showResults && <PollResultsModal poll={poll} onClose={() => setShowResults(false)} />}
    </div>
  );
}

const MAX_OPTIONS = 10; // бэкенд обрезает варианты до 10 (opts[:10])

/** Модалка создания голосования. */
export function PollCreateModal({
  onCreate,
  onClose,
}: {
  onCreate: (payload: PollPayload) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [showVoters, setShowVoters] = useState(false);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [allowChange, setAllowChange] = useState(true);
  const [allowBot, setAllowBot] = useState(true);
  const [error, setError] = useState('');

  const setOpt = (i: number, v: string) =>
    setOptions((prev) => prev.map((o, j) => (j === i ? v : o)));

  const submit = () => {
    const q = question.trim();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!q) {
      setError('Укажите вопрос голосования');
      return;
    }
    if (opts.length < 2) {
      setError('Нужно минимум 2 варианта');
      return;
    }
    onCreate({
      question: q,
      description: description.trim(),
      options: opts,
      allow_multiple: allowMultiple,
      show_voters: showVoters,
      allow_change: allowChange,
      allow_bot: allowBot,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[95] bg-black/30 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-gray-100 rounded-2xl shadow-xl w-full max-w-md p-5 flex flex-col gap-3 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-sm text-[#0f1c3f]">
            <BarChart3 size={16} className="text-[#2563eb]" />
            Новое голосование
          </div>
          <button onClick={onClose} className="p-1 text-gray-300 hover:text-gray-500 transition">
            <X size={16} />
          </button>
        </div>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={300}
          placeholder="Вопрос"
          className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:border-[#2563eb] focus:bg-white transition"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Описание (необязательно)"
          className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:border-[#2563eb] focus:bg-white transition resize-none"
        />
        <div className="flex flex-col gap-2">
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={o}
                onChange={(e) => setOpt(i, e.target.value)}
                maxLength={300}
                placeholder={`Вариант ${i + 1}`}
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:border-[#2563eb] focus:bg-white transition"
              />
              {options.length > 2 && (
                <button
                  onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                  className="p-1.5 text-gray-300 hover:text-red-500 transition"
                  title="Убрать вариант"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {options.length < MAX_OPTIONS && (
          <button
            onClick={() => setOptions((prev) => [...prev, ''])}
            className="flex items-center gap-1.5 text-xs font-semibold text-[#2563eb] hover:underline self-start"
          >
            <Plus size={14} /> Добавить вариант
          </button>
        )}
        <div className="flex flex-col gap-1.5 text-xs text-slate-600">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={showVoters} onChange={(e) => setShowVoters(e.target.checked)} />
            Показывать, кто как проголосовал
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={allowMultiple} onChange={(e) => setAllowMultiple(e.target.checked)} />
            Несколько ответов
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={allowChange} onChange={(e) => setAllowChange(e.target.checked)} />
            Разрешить менять ответ
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={allowBot} onChange={(e) => setAllowBot(e.target.checked)} />
            Может участвовать ИИ-ассистент
          </label>
        </div>
        {error && <div className="text-xs font-semibold text-red-500">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-200 text-slate-600 hover:bg-gray-50 transition"
          >
            Отмена
          </button>
          <button
            onClick={submit}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-[#2563eb] text-white hover:bg-[#1e40af] transition"
          >
            Создать
          </button>
        </div>
      </div>
    </div>
  );
}
