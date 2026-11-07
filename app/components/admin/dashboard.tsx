'use client';
import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  MessagesSquare,
  Newspaper,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import { apiGet } from '@/lib/api';
import { ErrorCallout } from '@/components/ui';
import { BarList, CHART, Heatmap, Legend, LineChart, Sparkline, StackedBar, fmtDay, fmtNum } from './charts';

type Period = 7 | 30 | 90 | 365;

interface Stats {
  days: number;
  since: string;
  generated_at: string;
  users: {
    total: number;
    active_accounts: number;
    admins: number;
    kb_editors: number;
    new: number;
    active: number;
    active_prev: number;
  };
  assistant: {
    questions: number;
    questions_prev: number;
    dialogues: number;
    dialogues_finished: number;
    answers: number;
    median_seconds: number | null;
    p90_seconds: number | null;
    feedback_up: number;
    feedback_down: number;
  };
  messenger: { messages: number; messages_prev: number };
  documents: { total: number; total_prev: number; by_generator: { generator: string; count: number }[] };
  kb: {
    indexed: number;
    in_progress: number;
    failed: number;
    archived: number;
    chunks: number;
    faq_active: number;
    sources_enabled: number;
    sources_failing: number;
  };
  news: { published: number };
  pii: { by_action: { action: string; count: number }[] };
  daily: { date: string; questions: number; messages: number; documents: number; active_users: number }[];
  heatmap: { dow: number; hour: number; count: number }[];
  top_users: {
    id: string;
    full_name: string;
    initials: string;
    position: string;
    questions: number;
    messages: number;
    documents: number;
  }[];
}

export const PII_ACTION_LABEL: Record<string, string> = {
  reauth_ok: 'Вход в раздел ПДн',
  reauth_fail: 'Ошибка входа в ПДн',
  view_person: 'Просмотр карточки',
  create_person: 'Создание карточки',
  delete_person: 'Удаление карточки',
  import_1c: 'Импорт из 1С',
  upload: 'Загрузка документа',
  download: 'Скачивание документа',
  delete: 'Удаление документа',
  quick_analyze: 'Быстрый анализ',
  timeout_save: 'Автовыход по таймауту',
};

const GENERATOR_LABEL: Record<string, string> = {
  template: 'По шаблону',
  vacancy: 'Вакансия',
  pps_announcement: 'Объявление ППС',
  ot_dedup: 'Дубликаты инструкций ОТ',
  employee_certificate: 'Справка на работника',
  dpo_report: 'Отчёт по ДПО',
  dismissed_inventory: 'Опись уволенных',
  process_schema: 'Схема процесса',
  characteristic: 'Характеристика',
};

const PERIODS: { value: Period; label: string }[] = [
  { value: 7, label: '7 дней' },
  { value: 30, label: '30 дней' },
  { value: 90, label: '90 дней' },
  { value: 365, label: 'Год' },
];

function fmtSeconds(s: number | null): string {
  if (s === null) return '—';
  if (s < 60) return `${s.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${Math.round(s - m * 60)} с`;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);

// Карточки

function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white border border-gray-100 rounded-2xl p-5 shadow-sm flex flex-col gap-4 min-w-0 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-[#0f1c3f]">{title}</h3>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Delta({ cur, prev, days }: { cur: number; prev: number; days: number }) {
  if (prev === 0 && cur === 0) return <span className="text-xs text-gray-400">без изменений</span>;
  if (prev === 0) return <span className="text-xs text-gray-400">в прошлом периоде — 0</span>;
  const change = Math.round(((cur - prev) / prev) * 100);
  const up = change >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`flex items-center gap-1 text-xs font-semibold ${up ? 'text-emerald-700' : 'text-red-600'}`}>
      <Icon size={14} />
      {up ? '+' : '−'}
      {Math.abs(change)}%<span className="font-normal text-gray-400">к предыдущим {days} дн.</span>
    </span>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  delta,
  trend,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: React.ReactNode;
  delta?: React.ReactNode;
  trend?: number[];
}) {
  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2 text-xs font-semibold text-gray-500">
        <span className="w-7 h-7 rounded-lg bg-blue-50 text-[#2563eb] flex items-center justify-center shrink-0">
          <Icon size={15} />
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div className="text-3xl font-bold text-[#0f1c3f] leading-tight">{value}</div>
      {delta}
      {hint && <div className="text-xs text-gray-400">{hint}</div>}
      {trend && trend.length > 1 && (
        <div className="mt-auto pt-1">
          <Sparkline values={trend} />
        </div>
      )}
    </div>
  );
}

function Meter({ value, tone }: { value: number; tone: 'good' | 'warning' | 'critical' }) {
  const fill = { good: CHART.good, warning: CHART.warning, critical: CHART.critical }[tone];
  return (
    <div className="h-2 w-full rounded-[4px] bg-gray-100 overflow-hidden">
      <div className="h-full rounded-r-[4px]" style={{ width: `${Math.max(2, value)}%`, background: fill }} />
    </div>
  );
}

function SegmentedPeriod({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div role="radiogroup" aria-label="Период" className="flex items-center gap-1 bg-white p-1 rounded-xl border border-gray-100 shadow-sm text-sm">
      {PERIODS.map((p) => (
        <button
          key={p.value}
          type="button"
          role="radio"
          aria-checked={value === p.value}
          onClick={() => onChange(p.value)}
          className={`px-3.5 py-1.5 rounded-lg font-medium transition ${
            value === p.value ? 'bg-[#2563eb] text-white' : 'text-gray-500 hover:text-slate-800 hover:bg-gray-50'
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// Дашборд

export function AdminDashboard({ refreshKey }: { refreshKey: number }) {
  const [days, setDays] = useState<Period>(30);
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  const loading = doneKey !== `${days}:${refreshKey}`;

  useEffect(() => {
    let cancelled = false;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    apiGet<Stats>(`/api/admin/stats?days=${days}&tz=${encodeURIComponent(tz)}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(`Не удалось загрузить статистику: ${e instanceof Error ? e.message : e}`);
      })
      .finally(() => {
        if (!cancelled) setDoneKey(`${days}:${refreshKey}`);
      });
    return () => {
      cancelled = true;
    };
  }, [days, refreshKey]);

  const filters = (
    <div className="flex flex-wrap items-center gap-3">
      <SegmentedPeriod value={days} onChange={setDays} />
      {loading && data && <Loader2 size={16} className="animate-spin text-gray-400" />}
      {data && (
        <span className="text-xs text-gray-400 ml-auto">
          с{' '}
          {new Date(data.since).toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: data.days > 90 ? 'numeric' : undefined,
          })}{' '}
          · обновлено{' '}
          {new Date(data.generated_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  );

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        {filters}
        {error ? <ErrorCallout>{error}</ErrorCallout> : <p className="text-center text-gray-400 py-16 text-sm">Загрузка…</p>}
      </div>
    );
  }

  const { users, assistant, messenger, documents, kb, pii, daily } = data;
  const rated = assistant.feedback_up + assistant.feedback_down;
  const positive = pct(assistant.feedback_up, rated);
  const solved = pct(assistant.dialogues_finished, assistant.dialogues);
  const reauthFails = pii.by_action.find((a) => a.action === 'reauth_fail')?.count ?? 0;
  const dates = daily.map((d) => d.date);

  return (
    <div className="flex flex-col gap-6">
      {filters}
      {error && <ErrorCallout>{error}</ErrorCallout>}

      <div className={`flex flex-col gap-6 transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatTile
            icon={Users}
            label="Активные пользователи"
            value={fmtNum(users.active)}
            delta={<Delta cur={users.active} prev={users.active_prev} days={data.days} />}
            hint={`из ${fmtNum(users.active_accounts)} учётных записей`}
            trend={daily.map((d) => d.active_users)}
          />
          <StatTile
            icon={Bot}
            label="Вопросы ассистенту"
            value={fmtNum(assistant.questions)}
            delta={<Delta cur={assistant.questions} prev={assistant.questions_prev} days={data.days} />}
            hint={`${fmtNum(assistant.dialogues)} новых диалогов`}
            trend={daily.map((d) => d.questions)}
          />
          <StatTile
            icon={MessagesSquare}
            label="Сообщения в мессенджере"
            value={fmtNum(messenger.messages)}
            delta={<Delta cur={messenger.messages} prev={messenger.messages_prev} days={data.days} />}
            trend={daily.map((d) => d.messages)}
          />
          <StatTile
            icon={FileText}
            label="Сгенерировано документов"
            value={fmtNum(documents.total)}
            delta={<Delta cur={documents.total} prev={documents.total_prev} days={data.days} />}
            trend={daily.map((d) => d.documents)}
          />
        </div>

        <Panel
          title="Активность по дням"
          subtitle="Вопросы ассистенту и сообщения коллегам"
          action={
            <button
              type="button"
              onClick={() => setAsTable((v) => !v)}
              className="text-xs font-semibold text-[#2563eb] hover:underline shrink-0"
            >
              {asTable ? 'Показать график' : 'Показать таблицей'}
            </button>
          }
        >
          {asTable ? (
            <div className="overflow-auto max-h-80 border border-gray-100 rounded-xl">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wider border-b border-gray-100">
                    <th className="px-4 py-2.5 font-semibold">Дата</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Вопросы</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Сообщения</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Документы</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Активных</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 tabular-nums">
                  {[...daily].reverse().map((d) => (
                    <tr key={d.date}>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {fmtDay(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}
                      </td>
                      <td className="px-4 py-2 text-xs text-right text-slate-700">{fmtNum(d.questions)}</td>
                      <td className="px-4 py-2 text-xs text-right text-slate-700">{fmtNum(d.messages)}</td>
                      <td className="px-4 py-2 text-xs text-right text-slate-700">{fmtNum(d.documents)}</td>
                      <td className="px-4 py-2 text-xs text-right text-slate-700">{fmtNum(d.active_users)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <Legend
                items={[
                  { label: 'Вопросы ассистенту', color: CHART.series1 },
                  { label: 'Сообщения в мессенджере', color: CHART.series2 },
                ]}
              />
              <LineChart
                dates={dates}
                series={[
                  { key: 'questions', label: 'вопросов ассистенту', color: CHART.series1 },
                  { key: 'messages', label: 'сообщений коллегам', color: CHART.series2 },
                ]}
                values={[daily.map((d) => d.questions), daily.map((d) => d.messages)]}
              />
            </>
          )}
        </Panel>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatTile
            icon={ThumbsUp}
            label="Полезные ответы"
            value={positive === null ? '—' : `${positive}%`}
            delta={positive !== null && <Meter value={positive} tone={positive >= 70 ? 'good' : positive >= 40 ? 'warning' : 'critical'} />}
            hint={
              rated ? (
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <ThumbsUp size={12} /> {fmtNum(assistant.feedback_up)}
                  </span>
                  <span className="flex items-center gap-1">
                    <ThumbsDown size={12} /> {fmtNum(assistant.feedback_down)}
                  </span>
                  <span>всего оценок: {fmtNum(rated)}</span>
                </span>
              ) : (
                'Оценок за период нет'
              )
            }
          />
          <StatTile
            icon={Clock}
            label="Время ответа (медиана)"
            value={fmtSeconds(assistant.median_seconds)}
            hint={
              assistant.answers
                ? `90% ответов — не дольше ${fmtSeconds(assistant.p90_seconds)} · всего ${fmtNum(assistant.answers)}`
                : 'Ответов за период нет'
            }
          />
          <StatTile
            icon={CheckCircle2}
            label="Диалоги с отметкой «решён»"
            value={solved === null ? '—' : `${solved}%`}
            hint={`${fmtNum(assistant.dialogues_finished)} из ${fmtNum(assistant.dialogues)} новых диалогов`}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="Документы по типам" subtitle="Что генерировали за период">
            <BarList
              items={documents.by_generator.map((g) => ({
                key: g.generator,
                label: GENERATOR_LABEL[g.generator] || g.generator,
                value: g.count,
              }))}
              empty="За период документов не создавали"
            />
          </Panel>

          <Panel title="База знаний" subtitle="Текущее состояние, без архивных редакций">
            <StackedBar
              segments={[
                { key: 'indexed', label: 'В поиске', value: kb.indexed, color: CHART.good, icon: CheckCircle2 },
                { key: 'progress', label: 'Обрабатываются', value: kb.in_progress, color: CHART.warning, icon: Clock },
                { key: 'failed', label: 'С ошибкой', value: kb.failed, color: CHART.critical, icon: AlertTriangle },
              ]}
            />
            <dl className="grid grid-cols-2 gap-3 text-xs">
              {[
                { label: 'Фрагментов в индексе', value: fmtNum(kb.chunks) },
                { label: 'Активных записей FAQ', value: fmtNum(kb.faq_active) },
                {
                  label: 'Веб-источников',
                  value: fmtNum(kb.sources_enabled),
                  note: kb.sources_failing ? `${kb.sources_failing} с ошибкой` : undefined,
                },
                { label: 'Архивных редакций', value: fmtNum(kb.archived) },
              ].map((it) => (
                <div key={it.label} className="bg-gray-50 border border-gray-100 rounded-xl px-3.5 py-3">
                  <dt className="text-gray-500">{it.label}</dt>
                  <dd className="text-lg font-bold text-[#0f1c3f] mt-0.5 flex items-baseline gap-2">
                    {it.value}
                    {it.note && (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-red-600">
                        <AlertTriangle size={12} /> {it.note}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="Когда задают вопросы" subtitle="Вопросы ассистенту по дням недели и часам">
            <Heatmap cells={data.heatmap} />
          </Panel>

          <Panel title="Самые активные сотрудники" subtitle="Вопросы ассистенту, сообщения и документы за период">
            {!data.top_users.length ? (
              <p className="text-center text-gray-400 py-8 text-sm">Активности за период нет</p>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wider border-b border-gray-100">
                      <th className="px-1 py-2 font-semibold">Сотрудник</th>
                      <th className="px-2 py-2 font-semibold text-right" title="Вопросы ассистенту">
                        <Bot size={14} className="inline" aria-label="Вопросы ассистенту" />
                      </th>
                      <th className="px-2 py-2 font-semibold text-right" title="Сообщения коллегам">
                        <MessagesSquare size={14} className="inline" aria-label="Сообщения коллегам" />
                      </th>
                      <th className="px-2 py-2 font-semibold text-right" title="Документы">
                        <FileText size={14} className="inline" aria-label="Документы" />
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.top_users.map((u) => (
                      <tr key={u.id}>
                        <td className="px-1 py-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="w-8 h-8 rounded-full bg-blue-100 text-[#2563eb] font-bold text-[11px] flex items-center justify-center shrink-0">
                              {u.initials}
                            </span>
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-[#0f1c3f] truncate">{u.full_name}</div>
                              <div className="text-[11px] text-gray-400 truncate">{u.position}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-xs text-right tabular-nums text-slate-700">{fmtNum(u.questions)}</td>
                        <td className="px-2 py-2 text-xs text-right tabular-nums text-slate-700">{fmtNum(u.messages)}</td>
                        <td className="px-2 py-2 text-xs text-right tabular-nums text-slate-700">{fmtNum(u.documents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="Пользователи и контент">
            <ul className="flex flex-col divide-y divide-gray-100 text-sm">
              {[
                { icon: Users, label: 'Учётных записей', value: users.total, note: `${fmtNum(users.active_accounts)} активных` },
                { icon: Users, label: 'Новых за период', value: users.new },
                { icon: ShieldAlert, label: 'Администраторов', value: users.admins },
                { icon: FileText, label: 'Редакторов базы знаний', value: users.kb_editors },
                { icon: Newspaper, label: 'Опубликовано новостей', value: data.news.published },
              ].map((r) => (
                <li key={r.label} className="flex items-center gap-3 py-2.5">
                  <r.icon size={16} className="text-gray-400 shrink-0" />
                  <span className="text-slate-600 flex-1">{r.label}</span>
                  {r.note && <span className="text-xs text-gray-400">{r.note}</span>}
                  <span className="font-bold text-[#0f1c3f] tabular-nums w-12 text-right">{fmtNum(r.value)}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Действия с персональными данными" subtitle="Журнал раздела ПДн за период">
            {reauthFails > 0 && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-100 text-red-700 rounded-xl px-3.5 py-2.5 text-xs font-semibold">
                <AlertTriangle size={14} className="shrink-0" />
                Неудачных входов в раздел: {fmtNum(reauthFails)}
              </div>
            )}
            <BarList
              items={pii.by_action.map((a) => ({
                key: a.action,
                label: PII_ACTION_LABEL[a.action] || a.action,
                value: a.count,
              }))}
              empty="Действий с ПДн за период не было"
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}
