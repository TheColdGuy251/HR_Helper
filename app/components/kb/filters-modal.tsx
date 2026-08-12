'use client';
import { useEffect, useState } from 'react';
import { Filter, RotateCcw, X } from 'lucide-react';
import { PrimaryButton } from '@/components/ui';

/* Модалка фильтров базы знаний — порт kb.js:126 wireKbFilters, :136-163
   (openFiltersModal / closeFiltersModal / updateFilterBadges) и разметки
   kb.html:243-330.

   Одна кнопка «Фильтры» на вкладку: бейдж показывает число выставленных
   параметров, «Сбросить» чистит фильтры вместе с поиском. */

export interface FilterDef {
  /** Ключ поля в объекте значений. */
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

const selectCls =
  'w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-[#2563eb] text-sm text-slate-700';

export default function KbFilters({
  defs,
  values,
  onChange,
  onReset,
}: {
  defs: FilterDef[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Сбрасывает фильтры И поиск (как kb.js:129). */
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = defs.filter((d) => values[d.key]).length;

  // Esc закрывает модалку.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Открыть фильтры"
        className={`relative border bg-white px-5 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition whitespace-nowrap ${
          active > 0
            ? 'border-blue-300 text-[#2563eb] hover:bg-blue-50'
            : 'border-gray-200 text-slate-600 hover:bg-gray-50'
        }`}
      >
        <Filter size={16} /> Фильтры
        {active > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-[#2563eb] text-white text-[11px] font-bold">
            {active}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-md p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-lg font-bold text-[#0f1c3f] flex items-center gap-2">
                <Filter size={18} className="text-[#2563eb]" /> Фильтры
              </h3>
              <button
                onClick={() => setOpen(false)}
                className="p-2 rounded-lg text-gray-400 hover:bg-gray-50 hover:text-slate-700 transition"
                aria-label="Закрыть"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex flex-col gap-3">
              {defs.map((d) => (
                <label key={d.key} className="flex flex-col gap-1.5 text-xs font-bold text-gray-500">
                  {d.label}
                  <select
                    value={values[d.key] || ''}
                    onChange={(e) => onChange(d.key, e.target.value)}
                    className={selectCls}
                  >
                    {d.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <button
              type="button"
              onClick={onReset}
              title="Сбросить фильтры и поиск"
              className="self-start inline-flex items-center gap-2 border border-gray-200 bg-white rounded-lg px-3 py-2 text-[13px] text-gray-500 hover:text-[#2563eb] hover:border-blue-300 transition"
            >
              <RotateCcw size={14} /> Сбросить
            </button>

            <div className="flex justify-end">
              <PrimaryButton onClick={() => setOpen(false)}>Готово</PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
