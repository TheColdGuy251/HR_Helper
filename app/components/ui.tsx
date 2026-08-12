'use client';
import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check, ChevronDown, Search } from 'lucide-react';

// Общие UI-элементы платформы. Все классы взяты дословно из страниц
// Tyuiu.bot-main (chat, knowledge-base, profile) — это эталон стиля.

/**
 * Стандартная обёртка страницы: как /chat и /knowledge-base.
 *
 * ВНИМАНИЕ: это вертикальный flex-контейнер (`flex flex-col`), растянутый на всю
 * высоту экрана (`flex-1`). Значит у любого прямого потомка с классом `flex-1`
 * главная ось — ВЕРТИКАЛЬНАЯ, и он съест всё свободное место по высоте, отодвинув
 * следующие блоки к низу окна. Прямым потомкам PageShell класс `flex-1` давать
 * нельзя (см. SearchInput ниже).
 */
export function PageShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`${wide ? 'max-w-6xl' : 'max-w-5xl'} w-full mx-auto px-4 py-8 flex-1 flex flex-col gap-6`}>
      {children}
    </div>
  );
}

/** Заголовок раздела с синей иконкой-плиткой. */
export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-[#2563eb] rounded-2xl flex items-center justify-center text-white shadow-md shadow-blue-200">
            <Icon size={24} />
          </div>
          <h1 className="text-2xl font-bold text-[#0f1c3f]">{title}</h1>
        </div>
        {actions}
      </div>
      {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
    </div>
  );
}

/** Белая карточка-панель. */
export function Card({
  children,
  className = '',
  interactive = false,
}: {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <div
      className={`bg-white border border-gray-100 rounded-2xl p-6 shadow-sm ${
        interactive ? 'hover:shadow-md transition' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** Основная синяя кнопка. */
export function PrimaryButton({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`bg-[#2563eb] text-white px-5 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 hover:bg-[#1e40af] transition shadow-md shadow-blue-100 disabled:opacity-60 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  );
}

/** Второстепенная кнопка (белая с рамкой). */
export function SecondaryButton({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`border border-gray-200 bg-white text-slate-600 px-5 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 hover:bg-gray-50 transition disabled:opacity-60 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  );
}

/** Красный текст ошибки в рамке. */
export function ErrorCallout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-xs font-semibold">
      {children}
    </div>
  );
}

/** Синяя информационная плашка. */
export function InfoCallout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-xs text-blue-800 font-medium">
      {children}
    </div>
  );
}

/** Пустое состояние списка. */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-center text-gray-400 py-10 bg-white rounded-2xl border border-dashed">
      {children}
    </p>
  );
}

/** Статусная "таблетка". tone: blue | emerald | amber | red | gray */
export function StatusPill({
  tone = 'blue',
  children,
}: {
  tone?: 'blue' | 'emerald' | 'amber' | 'red' | 'gray';
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    blue: 'bg-blue-50 text-[#2563eb]',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-red-50 text-red-600',
    gray: 'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider ${tones[tone]}`}>
      {children}
    </span>
  );
}

/**
 * Поиск с иконкой слева (как на /chat).
 *
 * По умолчанию корень — `flex-1`: компонент задуман для ГОРИЗОНТАЛЬНОГО ряда
 * (поиск + фильтры), где `flex-1` растягивает его по ширине.
 * Если поиск стоит отдельной строкой внутри вертикального flex-контейнера
 * (PageShell и его копии на /dialogues, /profile), тот же `flex-1` растягивает
 * блок ПО ВЫСОТЕ — под инпутом появляется пустой провал, а всё, что ниже,
 * прижимается к низу окна. В таких местах передавайте className="w-full".
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  className = 'flex-1',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Классы позиционирования корня. Заменяют значение по умолчанию, а не дополняют его. */
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search className="absolute left-4 top-3.5 text-gray-400" size={18} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-12 pr-4 py-3 bg-white border border-gray-100 rounded-2xl shadow-sm focus:outline-none focus:border-[#2563eb] text-sm text-slate-600"
      />
    </div>
  );
}

/** Сегментированные табы-"пилюли" (как на /chat). */
export function PillTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string }[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 bg-white p-1.5 rounded-xl border border-gray-100 shadow-sm text-sm">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`px-4 py-2 rounded-lg font-medium transition ${
            active === tab.key ? 'bg-[#2563eb] text-white' : 'text-gray-500 hover:text-slate-800'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ── Кастомный выпадающий список (порт makeCustomSelect, scripts.js:30-130) ──

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/**
 * Замена нативному <select> в стиле платформы. Управляемый компонент:
 * пустое значение показывает placeholder, как опция с value="" в легаси.
 */
export function CustomSelect<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = '— выберите —',
  disabled = false,
  className = '',
  ariaLabel,
}: {
  value: T | '';
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) || null;

  // Закрытие по клику вне и по Esc (порт onDocClick).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (opt: SelectOption<T>) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  /** Следующий доступный вариант в направлении dir (пропускаем disabled). */
  const step = (from: number, dir: 1 | -1) => {
    const n = options.length;
    for (let i = 1; i <= n; i++) {
      const idx = (((from + dir * i) % n) + n) % n;
      if (!options[idx]?.disabled) return idx;
    }
    return from;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(options.findIndex((o) => o.value === value));
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => step(i < 0 ? 0 : i, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[active];
      if (opt) pick(opt);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={`w-full flex items-center gap-2 px-4 py-3 bg-white border rounded-xl shadow-sm text-sm text-left transition disabled:opacity-60 disabled:cursor-not-allowed ${
          open ? 'border-[#2563eb]' : 'border-gray-100 hover:border-gray-200'
        }`}
      >
        <span className={`flex-1 truncate ${selected ? 'text-slate-600' : 'text-gray-400'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          size={16}
          className={`text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-30 mt-1 w-full max-h-60 overflow-y-auto bg-white border border-gray-100 rounded-xl shadow-lg py-1 animate-fade-in"
        >
          {options.length === 0 ? (
            <p className="px-4 py-2.5 text-xs text-gray-400">Нет вариантов</p>
          ) : (
            options.map((opt, i) => {
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={opt.disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(opt)}
                  className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left transition disabled:opacity-40 disabled:cursor-not-allowed ${
                    i === active ? 'bg-blue-50' : ''
                  } ${isSelected ? 'text-[#2563eb] font-semibold' : 'text-slate-600'}`}
                >
                  <span className="flex-1 truncate">{opt.label}</span>
                  {isSelected && <Check size={14} className="shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Табы с подчёркиванием (как на /knowledge-base). */
export function UnderlineTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string; icon?: LucideIcon }[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex items-center gap-6 border-b border-gray-200 pb-2 text-sm font-medium overflow-x-auto">
      {tabs.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`flex items-center gap-2 pb-2 border-b-2 transition whitespace-nowrap ${
            active === key
              ? 'border-[#2563eb] text-[#2563eb]'
              : 'border-transparent text-gray-400 hover:text-slate-700'
          }`}
        >
          {Icon && <Icon size={16} />} <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
