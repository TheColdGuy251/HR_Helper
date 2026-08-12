'use client';
import { useState } from 'react';
import { ChevronDown, ChevronLeft, Zap } from 'lucide-react';
import { apiGet } from '@/lib/api';

// Быстрый набор частых вопросов (FAQ отдела кадров), порт из chat.js:
// три уровня чипов — категория → вопрос → под-ветка. Выбор конечного пункта
// отправляет вопрос с faq_id → точный курируемый ответ без LLM.
// Формы — GET /api/chat/faq-menu (routes/chat.py: faq_menu).

interface FaqOption {
  id: number;
  label: string;
}

export interface FaqItem {
  block?: string;
  question: string;
  label?: string;
  id?: number;
  options?: FaqOption[];
}

export interface FaqCategory {
  label: string;
  items: FaqItem[];
}

export function FaqPicker({
  disabled,
  onPick,
}: {
  disabled?: boolean;
  onPick: (text: string, faqId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<FaqCategory[] | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [stack, setStack] = useState<number[]>([]); // [] → [кат] → [кат, вопрос]

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || menu) return;
    setState('loading');
    try {
      const d = await apiGet<{ categories: FaqCategory[] }>('/api/chat/faq-menu');
      setMenu((d.categories || []).filter((c) => c.items && c.items.length));
      setState('idle');
    } catch {
      setState('error');
    }
  };

  const pick = (text: string, faqId: number) => {
    setOpen(false);
    setStack([]);
    onPick(text, faqId);
  };

  const cat = menu && stack.length > 0 ? menu[stack[0]] : null;
  const item = cat && stack.length > 1 ? cat.items[stack[1]] : null;

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-[#2563eb] transition disabled:opacity-50"
      >
        <Zap size={13} className="text-[#2563eb]" />
        Частые вопросы
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-2 bg-white border border-gray-100 rounded-xl shadow-sm p-3 max-h-64 overflow-y-auto animate-fade-in">
          {state === 'loading' && <p className="text-xs text-gray-400">Загрузка…</p>}
          {state === 'error' && <p className="text-xs text-red-500">Не удалось загрузить FAQ</p>}
          {state === 'idle' && menu && !menu.length && (
            <p className="text-xs text-gray-400">FAQ пока не загружен</p>
          )}

          {state === 'idle' && menu && menu.length > 0 && (
            <>
              {/* Хлебные крошки + «назад» */}
              {stack.length > 0 && (
                <div className="flex items-center gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setStack((s) => s.slice(0, -1))}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#2563eb] hover:underline"
                  >
                    <ChevronLeft size={12} /> Назад
                  </button>
                  <span className="text-[11px] text-gray-400 truncate">
                    {cat?.label}
                    {item ? ` → ${item.label || item.block || item.question}` : ''}
                  </span>
                </div>
              )}

              {/* Уровень 1: категории — компактные «таблетки» */}
              {stack.length === 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {menu.map((c, i) => (
                    <button
                      key={c.label}
                      type="button"
                      onClick={() => setStack([i])}
                      className="px-3 py-1.5 rounded-lg bg-blue-50 text-[#2563eb] text-xs font-semibold hover:bg-blue-100 transition"
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Уровень 2: вопросы категории — вертикальный список */}
              {stack.length === 1 && cat && (
                <div className="flex flex-col gap-1">
                  {cat.items.map((it, j) => {
                    const hasOpts = !!(it.options && it.options.length);
                    return (
                      <button
                        key={j}
                        type="button"
                        onClick={() => {
                          if (hasOpts) setStack([stack[0], j]);
                          else if (typeof it.id === 'number') pick(it.question, it.id);
                        }}
                        className="w-full text-left px-3 py-2 rounded-lg text-xs text-slate-600 hover:bg-gray-50 hover:text-[#0f1c3f] font-medium transition flex items-center justify-between gap-2"
                      >
                        <span>{it.label || it.block || it.question}</span>
                        {hasOpts && <ChevronDown size={12} className="-rotate-90 shrink-0 text-gray-300" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Уровень 3: под-ветки вопроса */}
              {stack.length === 2 && item && (
                <div className="flex flex-col gap-1">
                  {(item.options || []).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => pick(`${item.question} — ${opt.label}`, opt.id)}
                      className="w-full text-left px-3 py-2 rounded-lg text-xs text-slate-600 hover:bg-blue-50 hover:text-[#2563eb] font-medium transition"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
