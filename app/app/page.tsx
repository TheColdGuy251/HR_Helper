'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  Award,
  BarChart3,
  Briefcase,
  Clock,
  Contact,
  Copy,
  Download,
  ExternalLink,
  FileSignature,
  FileText,
  Loader2,
  Megaphone,
  Search,
  SendHorizontal,
  Table2,
  Trash2,
  Wand2,
  Workflow,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost, timeAgo } from '@/lib/api';
import { ErrorCallout, SearchInput, StatusPill } from '@/components/ui';
import { ToolModal, type ToolKey } from '@/components/home/tool-modals';

// Главная страница: hero, поиск по инструментам, 3 группы карточек-мастеров
// и грид «Мои документы» (порт HR Helper/templates/index.html).

/* ───────────────────────── Каталог инструментов ───────────────────────── */

interface ToolDef {
  key: ToolKey;
  title: string;
  desc: string;
  keywords: string;
  action: string;
  icon: LucideIcon;
  tile: string; // градиент плитки — цвета из легаси home.css
}

interface ToolGroup {
  title: string;
  icon: LucideIcon;
  tools: ToolDef[];
}

const GROUPS: ToolGroup[] = [
  {
    title: 'Документы по сотрудникам',
    icon: FileSignature,
    tools: [
      {
        key: 'characteristic',
        title: 'Характеристика на награду',
        desc: 'Загрузите ходатайство из 1С — ИИ подготовит характеристику по образцам ТИУ',
        keywords: 'характеристика награда ходатайство поощрение благодарность',
        action: 'Создать',
        icon: Award,
        tile: 'from-[#F59E0B] to-[#FBBF24]', // amber
      },
      {
        key: 'certificate',
        title: 'Справка на работника',
        desc: 'Выгрузка из 1С:ЗиК — читабельная справка: ПК за 3 года, работа по должностям без дублей',
        keywords: 'справка работник сотрудник 1с зик стаж повышение квалификации',
        action: 'Создать',
        icon: Contact,
        tile: 'from-[#0284C7] to-[#38BDF8]', // sky
      },
      {
        key: 'vacancy',
        title: 'Вакансия из инструкции',
        desc: 'Загрузите должностную инструкцию — ИИ превратит раздел обязанностей в текст для job-сайтов',
        keywords: 'вакансия должностная инструкция hh джоб работа объявление найм',
        action: 'Создать',
        icon: Briefcase,
        tile: 'from-[#059669] to-[#34D399]', // emerald
      },
    ],
  },
  {
    title: 'Отчёты и описи из 1С',
    icon: Table2,
    tools: [
      {
        key: 'dpo',
        title: 'Отчёт по ДПО',
        desc: 'Загрузите выгрузку «ПК за период» из 1С:ЗиК — получите готовый word-отчёт с точными цифрами',
        keywords: 'дпо отчёт повышение квалификации обучение переподготовка год',
        action: 'Создать',
        icon: BarChart3,
        tile: 'from-[#2563eb] to-[#7C3AED]', // indigo (blue → purple)
      },
      {
        key: 'inventory',
        title: 'Опись уволенных',
        desc: 'Отчёт «Принято уволено» — опись личных дел для архива (без повторно принятых)',
        keywords: 'опись уволенные архив личные дела принято уволено',
        action: 'Создать',
        icon: Archive,
        tile: 'from-[#E11D48] to-[#FB7185]', // rose
      },
      {
        key: 'pps',
        title: 'Объявление конкурса ППС',
        desc: 'Выгрузки «Форма 2» — word-объявление о выборах завкафедрами и конкурсе ППС',
        keywords: 'конкурс ппс выборы заведующий кафедра объявление профессор доцент',
        action: 'Создать',
        icon: Megaphone,
        tile: 'from-[#7C3AED] to-[#A78BFA]', // violet
      },
    ],
  },
  {
    title: 'Схемы и анализ',
    icon: Wand2,
    tools: [
      {
        key: 'process',
        title: 'Единая схема процесса',
        desc: 'Загрузите схему из Word, Excel или PowerPoint — получите схему в едином стиле ТИУ',
        keywords: 'схема процесс единый вид стиль word excel powerpoint svg',
        action: 'Преобразовать',
        icon: Workflow,
        tile: 'from-[#0f1c3f] to-[#2563eb]', // фирменный синий градиент
      },
      {
        key: 'otdedup',
        title: 'Дубликаты инструкций ОТ',
        desc: 'Загрузите архив инструкций — получите пары с совпадением текста более 80% и группы однотипных',
        keywords: 'дубликаты инструкции охрана труда однотипные совпадение сравнение',
        action: 'Найти',
        icon: Copy,
        tile: 'from-[#0D9488] to-[#2DD4BF]', // teal
      },
    ],
  },
];

/* ───────────────────────── Мои документы ───────────────────────── */

// Форма ответа GET /api/documents (routes/documents.py:264)
interface DocItem {
  id: number;
  title: string | null;
  template_key: string | null;
  status: string | null;
  progress: number | null;
  last_activity: string;
}

const TEMPLATE_LABELS: Record<string, string> = {
  characteristic: 'Характеристика',
  dpo_report: 'Отчёт по ДПО',
  employee_certificate: 'Справка на работника',
  dismissed_inventory: 'Опись уволенных',
  pps_announcement: 'Объявление ППС',
  vacancy: 'Вакансия',
  ot_dedup: 'Дубликаты инструкций ОТ',
};

function docStatus(status: string | null): { label: string; tone: 'emerald' | 'amber' | 'gray' } {
  if (!status || status === 'ready') return { label: 'Готов', tone: 'emerald' };
  if (status === 'draft') return { label: 'Черновик', tone: 'amber' };
  return { label: status, tone: 'gray' };
}

function DocCard({ doc, onDelete }: { doc: DocItem; onDelete: (doc: DocItem) => void }) {
  const st = docStatus(doc.status);
  const title = doc.title || 'Без названия';
  return (
    <div className="relative bg-white border border-gray-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition flex flex-col gap-3">
      <button
        type="button"
        onClick={() => onDelete(doc)}
        title="Удалить документ"
        className="absolute top-3 right-3 w-8 h-8 rounded-lg flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 transition"
      >
        <Trash2 size={16} />
      </button>

      <div className="flex items-start gap-3 pr-8">
        <div className="w-10 h-10 bg-blue-50 text-[#2563eb] rounded-xl flex items-center justify-center shrink-0">
          <FileText size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-[#0f1c3f] leading-snug break-words" title={title}>
            {title}
          </h3>
          {doc.template_key && (
            <p className="text-xs text-gray-400 font-medium mt-0.5">
              {TEMPLATE_LABELS[doc.template_key] || doc.template_key}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-xs text-gray-400 font-medium">
        <Clock size={13} />
        <span>{timeAgo(doc.last_activity)}</span>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-gray-50">
        <StatusPill tone={st.tone}>{st.label}</StatusPill>
        <div className="flex items-center gap-1">
          <a
            href={`/documents/${doc.id}/view`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Открыть «${title}» для просмотра`}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-gray-500 hover:text-[#2563eb] hover:bg-blue-50 transition"
          >
            <ExternalLink size={14} /> Открыть
          </a>
          <a
            href={`/api/documents/${doc.id}/download`}
            title={`Скачать «${title}»`}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-gray-500 hover:text-[#2563eb] hover:bg-blue-50 transition"
          >
            <Download size={14} /> Скачать
          </a>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── Поле запроса к ассистенту ─────────────────── */

/**
 * Спросить ассистента прямо с главной: создаём диалог и уходим в него с
 * вопросом в `?q=` — страница чата отправит его сама.
 *
 * Тело запроса намеренно пустое: POST /api/dialogues без title переиспользует
 * уже существующий пустой диалог (route.ts:248), поэтому «спросил и передумал»
 * не плодит чаты, а заголовок подберётся автоматически по первому ответу.
 */
function AskAssistant() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Поле растёт вместе с текстом, но не выше пяти строк.
  const autoGrow = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  const ask = async (value: string) => {
    const question = value.trim();
    if (!question || sending) return;
    setSending(true);
    setError('');
    try {
      // В адресе чата стоит session_id, а не id диалога (app/chat/[id]).
      const d = await apiPost<{ session_id: string }>('/api/dialogues');
      router.push(`/chat/${d.session_id}?q=${encodeURIComponent(question)}`);
    } catch {
      setError('Не удалось открыть диалог. Попробуйте ещё раз.');
      setSending(false);
    }
  };

  const submit = () => ask(text);

  return (
    <div className="w-full max-w-2xl flex flex-col gap-3">
      <div className="bg-white border border-gray-100 rounded-2xl shadow-md shadow-blue-50 p-2 flex items-end gap-2 focus-within:border-blue-300 focus-within:shadow-blue-100 transition">
        <textarea
          ref={areaRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow();
          }}
          onKeyDown={(e) => {
            // Enter отправляет, Shift+Enter переносит строку — как в чате.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Спросите ассистента: «как оформить отпуск за свой счёт?»"
          disabled={sending}
          className="flex-1 resize-none bg-transparent px-3 py-2.5 text-sm text-slate-700 placeholder:text-gray-400 focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() || sending}
          title="Спросить ассистента"
          className="shrink-0 w-10 h-10 rounded-xl bg-[#2563eb] text-white flex items-center justify-center hover:bg-[#1e40af] transition disabled:opacity-40 disabled:hover:bg-[#2563eb]"
        >
          {sending ? <Loader2 size={18} className="animate-spin" /> : <SendHorizontal size={18} />}
        </button>
      </div>

      {error && <p className="text-xs text-red-500 text-left px-1">{error}</p>}
    </div>
  );
}

/* ───────────────────────── Страница ───────────────────────── */

export default function HomePage() {
  const [query, setQuery] = useState('');
  const [activeTool, setActiveTool] = useState<ToolKey | null>(null);

  const [docs, setDocs] = useState<DocItem[] | null>(null);
  const [docsError, setDocsError] = useState('');

  const loadDocs = useCallback(async () => {
    try {
      const d = await apiGet<{ items: DocItem[] }>('/api/documents');
      setDocs(d.items || []);
      setDocsError('');
    } catch {
      setDocs((cur) => cur ?? []);
      setDocsError('Не удалось загрузить список документов');
    }
  }, []);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  // Удаление с confirm — оптимистично, при ошибке возвращаем список
  const handleDelete = async (doc: DocItem) => {
    const title = (doc.title || '').trim();
    if (!confirm(`Удалить документ${title ? ` «${title}»` : ''}? Файл будет безвозвратно стёрт.`)) return;
    const prev = docs;
    setDocs((cur) => (cur ?? []).filter((d) => d.id !== doc.id));
    try {
      await apiDelete(`/api/documents/${doc.id}`);
    } catch {
      setDocs(prev);
      setDocsError('Не удалось удалить документ');
    }
  };

  // Живой поиск: карточка видна, если каждое слово запроса найдено
  // в названии, описании или ключевых словах (как в легаси index.html)
  const q = query.trim().toLowerCase();
  const matches = (t: ToolDef) => {
    if (!q) return true;
    const hay = `${t.title} ${t.desc} ${t.keywords}`.toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  };
  const visibleGroups = GROUPS.map((g) => ({ ...g, tools: g.tools.filter(matches) })).filter(
    (g) => g.tools.length > 0
  );

  return (
    <div className="max-w-6xl w-full mx-auto px-4 py-8 flex-1 flex flex-col gap-10 md:gap-16">
      {/* ── Hero ──
          Логотип ТИУ убран: он уже стоит в шапке, а на первом экране только
          отодвигал вниз то, ради чего сюда заходят — строку запроса. */}
      <section className="flex flex-col items-center text-center gap-3 pt-2">
        <h1 className="text-3xl md:text-4xl font-black tracking-tight leading-tight">
          <span className="text-gradient">Что нужно сделать?</span>
        </h1>
        <p className="text-sm text-gray-400 max-w-lg font-medium leading-relaxed">
          Спросите ассистента или выберите готовый мастер: характеристики, отчёты, описи и
          схемы собираются из выгрузок 1С за пару кликов.
        </p>

        {/* Спросить ассистента прямо отсюда — не заходя в раздел диалогов. */}
        <AskAssistant />
      </section>

      {/* ── Мастера документов: шапка с поиском и группы карточек ── */}
      <section className="flex flex-col gap-8">
        <div className="flex flex-col items-center gap-4">
          <h2 className="text-xl font-bold text-[#0f1c3f] flex items-center gap-2">
            <Wand2 size={20} className="text-[#2563eb]" /> Мастера документов
          </h2>
          {/* w-full вместо flex-1 по умолчанию: в вертикальной оси flex-1
              забрал бы свободную высоту (см. ui.tsx). */}
          <SearchInput
            className="w-full max-w-xl"
            value={query}
            onChange={setQuery}
            placeholder="Найти мастер: отпуск, справка, опись…"
          />
        </div>

        {visibleGroups.map((group) => (
          <div key={group.title} className="flex flex-col gap-4">
            {/* Подзаголовок группы — на ступень мельче заголовка раздела,
                иначе два уровня выглядят одинаково и иерархия теряется. */}
            <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-gray-400">
              <group.icon size={15} className="text-[#2563eb]" /> {group.title}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {group.tools.map((tool) => (
                <button
                  key={tool.key}
                  type="button"
                  onClick={() => setActiveTool(tool.key)}
                  className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm hover:shadow-md hover:border-blue-200 transition text-left flex flex-col gap-3 group cursor-pointer"
                >
                  <div
                    className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${tool.tile} flex items-center justify-center text-white shadow-md`}
                  >
                    <tool.icon size={22} />
                  </div>
                  <h3 className="text-base font-bold text-[#0f1c3f] leading-snug">{tool.title}</h3>
                  <p className="text-xs text-gray-500 font-medium leading-relaxed flex-1">{tool.desc}</p>
                  <span className="text-xs font-bold text-[#2563eb] group-hover:text-[#1e40af] transition">
                    {tool.action} →
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}

        {q && visibleGroups.length === 0 && (
          <div className="bg-white border border-dashed border-gray-200 rounded-2xl p-10 text-center flex flex-col items-center gap-3">
            <Search size={28} className="text-gray-300" />
            <p className="text-sm text-gray-500 font-medium">
              По запросу ничего не найдено среди инструментов.
            </p>
            <p className="text-sm text-gray-500 font-medium">
              Попробуйте{' '}
              <Link href="/dialogues" className="text-[#2563eb] font-semibold hover:underline">
                спросить у ИИ-ассистента
              </Link>{' '}
              — приказы, заявления и любые кадровые вопросы он оформит в диалоге.
            </p>
          </div>
        )}
      </section>

      {/* ── Мои документы ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-[#0f1c3f]">Мои документы</h2>
          {docs !== null && (
            <span className="text-xs font-bold bg-blue-50 text-[#2563eb] px-2.5 py-1 rounded-full">
              {docs.length}
            </span>
          )}
        </div>

        {docsError && <ErrorCallout>{docsError}</ErrorCallout>}

        {docs === null ? (
          <p className="text-sm text-gray-400 font-medium py-6 text-center">Загрузка документов...</p>
        ) : docs.length === 0 ? (
          <p className="text-center text-gray-400 py-10 bg-white rounded-2xl border border-dashed text-sm font-medium">
            У вас пока нет сохранённых документов. Создайте первый по карточкам выше.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {docs.map((doc) => (
              <DocCard key={doc.id} doc={doc} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </section>

      {/* ── Модалка активного мастера ── */}
      {activeTool && (
        <ToolModal tool={activeTool} onClose={() => setActiveTool(null)} onDocsChanged={loadDocs} />
      )}
    </div>
  );
}
