'use client';
import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { CheckCircle2, Loader2, Upload, X } from 'lucide-react';
import { ApiError } from '@/lib/api';

// Общий каркас модалок-мастеров главной страницы.
// Стиль — Tyuiu.bot-main: белые карточки rounded-2xl, синий #2563eb.

/** Человекочитаемый текст ошибки запроса. */
export function errText(e: unknown): string {
  if (e instanceof ApiError) return `Ошибка: ${e.message}`;
  if (e instanceof Error) return `Ошибка соединения: ${e.message}`;
  return 'Неизвестная ошибка';
}

/** Оверлей + карточка модалки: клик по фону и Esc закрывают. */
export function ModalShell({
  icon: Icon,
  title,
  wide = false,
  onClose,
  children,
}: {
  icon: LucideIcon;
  title: string;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[90] bg-[#0f1c3f]/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-white rounded-2xl border border-gray-100 shadow-xl w-full ${
          wide ? 'max-w-3xl' : 'max-w-xl'
        } max-h-[88vh] flex flex-col animate-fade-in`}
      >
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="w-9 h-9 bg-[#2563eb] rounded-xl flex items-center justify-center text-white shrink-0 shadow-md shadow-blue-100">
            <Icon size={18} />
          </div>
          <h2 className="flex-1 text-base font-bold text-[#0f1c3f] leading-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-slate-700 hover:bg-gray-100 transition shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

/** Серая подсказка-описание шага. */
export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-500 leading-relaxed font-medium">{children}</p>;
}

/** Кнопка выбора файла (пунктирная зона, показывает имя выбранного). */
export function FilePick({
  accept,
  multiple = false,
  placeholder,
  busy = false,
  onPick,
}: {
  accept: string;
  multiple?: boolean;
  placeholder: string;
  busy?: boolean;
  onPick: (files: File[]) => void;
}) {
  const [name, setName] = useState('');
  return (
    <label
      className={`flex items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-2xl px-4 py-6 text-sm font-semibold text-slate-600 transition ${
        busy
          ? 'opacity-60 cursor-wait'
          : 'cursor-pointer hover:border-[#2563eb] hover:text-[#2563eb] hover:bg-blue-50/50'
      }`}
    >
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        disabled={busy}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (!files.length) return;
          setName(files.length === 1 ? files[0].name : `${files.length} файлов`);
          onPick(files);
          e.target.value = ''; // тот же файл можно выбрать повторно
        }}
      />
      <Upload size={18} className="shrink-0 text-[#2563eb]" />
      <span className="truncate">{name || placeholder}</span>
    </label>
  );
}

/** Индикатор выполнения запроса. */
export function BusyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold text-[#2563eb] bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
      <Loader2 size={16} className="animate-spin shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Заголовок результата с зелёной галочкой. */
export function ResultHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm font-bold">
      <CheckCircle2 size={18} className="shrink-0 mt-0.5 text-emerald-500" />
      <span className="text-[#0f1c3f]">{children}</span>
    </div>
  );
}

/** Чипы со статистикой (как .dpo-chip в легаси). */
export function StatChips({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(([label, value]) => (
        <span
          key={label}
          className="inline-flex items-center gap-1.5 bg-blue-50 text-blue-800 border border-blue-100 rounded-full px-3 py-1 text-xs font-medium"
        >
          <b className="font-bold">{value}</b> {label}
        </span>
      ))}
    </div>
  );
}

/** Текстовый предпросмотр документа. */
export function TextPreview({ text }: { text: string }) {
  return (
    <pre className="bg-gray-50 border border-gray-100 rounded-xl p-4 text-xs text-slate-700 whitespace-pre-wrap max-h-72 overflow-y-auto font-sans leading-relaxed">
      {text}
    </pre>
  );
}

// Классы кнопок-ссылок — дословно как PrimaryButton/SecondaryButton из ui.tsx.
const PRIMARY_LINK =
  'bg-[#2563eb] text-white px-5 py-3 rounded-xl font-semibold text-sm inline-flex items-center justify-center gap-2 hover:bg-[#1e40af] transition shadow-md shadow-blue-100';
const SECONDARY_LINK =
  'border border-gray-200 bg-white text-slate-600 px-5 py-3 rounded-xl font-semibold text-sm inline-flex items-center justify-center gap-2 hover:bg-gray-50 transition';

/** Синяя кнопка-ссылка (скачивание). */
export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className={PRIMARY_LINK}>
      {children}
    </a>
  );
}

/** Белая кнопка-ссылка (просмотр в новой вкладке). */
export function SecondaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={SECONDARY_LINK}>
      {children}
    </a>
  );
}

/** Компактная таблица результатов со скроллом. */
export function SimpleTable({
  head,
  rows,
}: {
  head: string[];
  rows: { cells: React.ReactNode[]; highlight?: boolean }[];
}) {
  return (
    <div className="overflow-auto border border-gray-100 rounded-xl max-h-80">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 text-left text-gray-500">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-t border-gray-100 ${r.highlight ? 'bg-amber-50' : ''}`}>
              {r.cells.map((c, j) => (
                <td key={j} className="px-3 py-2 text-slate-600 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
