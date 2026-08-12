'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Folder, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* Группы-блоки базы знаний — порт kb.js:30 renderGroupBlocks / :75 toggleKbGroup /
   :88 updateKbGroupFit / :99 (клик по фону) / :105 applyGroupView.

   Документы, источники, шаблоны и FAQ группируются в блоки, стоящие в 3 колонки.
   Свернутый блок ограничен по высоте (стрелка внизу); раскрытый растёт вниз ПОВЕРХ
   нижних групп, не сдвигая раскладку. Раскрыт всегда ровно один блок: открытие
   одного схлопывает остальные, клик по фону страницы закрывает все. */

// На сервере layout-эффектов нет — иначе Next ругается предупреждением.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface GroupSection {
  /** Ключ группы — он же значение фильтра «Группа». */
  key: string;
  name: string;
  icon?: LucideIcon;
  /** Уже отфильтрованные карточки группы. */
  items: { key: React.Key; node: React.ReactNode }[];
}

/** Собрать элементы в секции по ключу группы, сохранив порядок ключей из `order`. */
export function buildSections<T>(
  items: T[],
  groupOf: (item: T) => { key: string; name: string; icon?: LucideIcon },
  render: (item: T) => { key: React.Key; node: React.ReactNode },
  sort?: (a: GroupSection, b: GroupSection) => number,
): GroupSection[] {
  const map = new Map<string, GroupSection>();
  for (const it of items) {
    const g = groupOf(it);
    if (!map.has(g.key)) map.set(g.key, { ...g, items: [] });
    map.get(g.key)!.items.push(render(it));
  }
  const list = [...map.values()];
  return sort ? list.sort(sort) : list;
}

export default function GroupBlocks({
  sections,
  note,
}: {
  sections: GroupSection[];
  /** Плашка над плиткой (сводка по актуальности и т.п.) — во всю ширину. */
  note?: React.ReactNode;
}) {
  const [wantOpenKey, setOpenKey] = useState<string | null>(null);
  // Группа могла исчезнуть из выдачи после фильтрации — раскрывать нечего.
  const openKey = wantOpenKey && sections.some((s) => s.key === wantOpenKey) ? wantOpenKey : null;
  // Ключи групп, чьё содержимое влезло целиком: у них стрелка не нужна.
  const [fitKeys, setFitKeys] = useState<Set<string>>(new Set());
  const itemsRefs = useRef(new Map<string, HTMLDivElement | null>());

  // Стрелка и прокрутка нужны только там, где список реально обрезан по высоте.
  // Раскрытые блоки не мерим: «влезаемость» оценивается в свернутом виде.
  const measure = useCallback(() => {
    const next = new Set<string>();
    for (const [key, el] of itemsRefs.current) {
      if (!el || key === openKey) continue;
      if (!el.clientHeight) continue; // вкладка скрыта — не мерим
      if (el.scrollHeight <= el.clientHeight + 4) next.add(key);
    }
    setFitKeys((prev) => {
      if (prev.size === next.size && [...next].every((k) => prev.has(k))) return prev;
      return next;
    });
  }, [openKey]);

  useIsoLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // Клик по пустому месту страницы сворачивает раскрытый блок.
  useEffect(() => {
    if (!openKey) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest('[data-kb-group-card], [role="dialog"]')) return;
      setOpenKey(null);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [openKey]);

  const toggle = (key: string, force?: boolean) => {
    setOpenKey((cur) => {
      const open = force != null ? force : cur !== key;
      return open ? key : null;
    });
  };

  const onCardClick = (e: React.MouseEvent<HTMLDivElement>, key: string) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-kb-group-close]')) {
      toggle(key, false);
      return;
    }
    if (!target.closest('[data-kb-group-arrow]')) {
      // «Свободное место» блока: карточки, кнопки и поля ввода не в счёт.
      if (target.closest('a, button, input, textarea, select, label, [data-kb-item]')) return;
      // Свернутые списки прокручиваются: клик по вертикальному скроллбару —
      // это листание, а не сворачивание/раскрытие.
      const items = target.closest('[data-kb-group-items]');
      if (items && target === items) {
        const r = items.getBoundingClientRect();
        if (e.clientX > r.left + items.clientWidth) return;
      }
    }
    toggle(key);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5 items-start">
      {note && <div className="col-span-full">{note}</div>}
      {sections.map((sec) => {
        const isOpen = openKey === sec.key;
        const fits = fitKeys.has(sec.key);
        const Icon = sec.icon || Folder;
        return (
          <div
            key={sec.key}
            className={`relative h-[340px] md:h-[640px] ${isOpen ? 'z-40' : ''}`}
          >
            {/* На мобильном раскрытый блок работает почти как модалка: затемнение
                вокруг (тап по нему закрывает — сработает документный обработчик). */}
            {isOpen && <div className="md:hidden fixed inset-0 bg-slate-900/45" aria-hidden />}
            <div
              data-kb-group-card
              onClick={(e) => onCardClick(e, sec.key)}
              className={`absolute left-0 right-0 top-0 flex flex-col bg-white border rounded-2xl overflow-hidden cursor-pointer transition-shadow ${
                isOpen
                  ? 'bottom-auto h-auto min-h-full max-h-[84vh] border-blue-300 shadow-xl z-[1]'
                  : 'bottom-0 border-gray-100 shadow-sm hover:border-gray-300'
              }`}
            >
              {/* Шапка группы */}
              <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2.5 text-[12.5px] font-bold uppercase tracking-wider text-[#0f1c3f]">
                <Icon size={15} className="text-[#2563eb] shrink-0" />
                <span className="truncate">{sec.name}</span>
                <span className="ml-auto shrink-0 bg-blue-50 text-gray-500 text-[12px] font-semibold rounded-full px-2.5 py-0.5 normal-case tracking-normal">
                  {sec.items.length}
                </span>
                {isOpen && (
                  <button
                    data-kb-group-close
                    type="button"
                    title="Свернуть"
                    aria-label="Свернуть"
                    className="md:hidden shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-lg bg-blue-50 text-[#2563eb]"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {/* Список карточек группы */}
              <div
                data-kb-group-items
                ref={(el) => {
                  itemsRefs.current.set(sec.key, el);
                }}
                className={`flex-1 min-h-0 flex flex-col gap-2 px-2.5 pb-2 overscroll-contain ${
                  isOpen ? 'overflow-y-auto' : 'overflow-y-auto max-md:overflow-hidden'
                } ${
                  // Свернутый и обрезанный список на мобильном затухает книзу — намёк
                  // на продолжение (листать можно только после раскрытия).
                  !isOpen && !fits
                    ? 'max-md:[mask-image:linear-gradient(180deg,#000_70%,transparent_98%)]'
                    : ''
                }`}
              >
                {sec.items.map((it) => (
                  <div key={it.key} data-kb-item>
                    {it.node}
                  </div>
                ))}
              </div>

              {/* Стрелка «развернуть / свернуть» */}
              <button
                data-kb-group-arrow
                type="button"
                title="Развернуть / свернуть"
                className={`shrink-0 pt-1.5 pb-2.5 text-[#2563eb] hover:text-[#1e40af] transition ${
                  fits && !isOpen ? 'invisible' : ''
                }`}
              >
                <ChevronDown
                  size={16}
                  className={`mx-auto transition-transform ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
