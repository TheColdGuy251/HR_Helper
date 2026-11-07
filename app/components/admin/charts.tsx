'use client';
import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

// Графики дашборда на SVG/CSS. Цвета - фирменный синий и проверенная пара к
// нему; оси и сетка нарочно бледные, чтобы не спорить с данными.

export const CHART = {
  series1: '#2563eb',
  series2: '#eb6834',
  grid: '#eef0f4',
  axis: '#d5d9e0',
  muted: '#8a93a3',
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
};

// Последовательная шкала для тепловой карты: от "почти нет" к максимуму.
const HEAT_STEPS = ['#f3f5f9', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];

export const fmtNum = (n: number) => n.toLocaleString('ru-RU');

export function fmtDay(key: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) {
  const d = new Date(`${key}T00:00:00`);
  return d.toLocaleDateString('ru-RU', opts).replace('.', '');
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceScale(max: number, ticks = 4) {
  if (max <= 0) return { top: ticks, step: 1 };
  const rough = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= rough) ?? 10 * mag;
  return { top: Math.ceil(max / step) * step, step };
}

// Спарклайн

export function Sparkline({ values, color = CHART.series1 }: { values: number[]; color?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const h = 32;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => {
    const x = values.length > 1 ? (i / (values.length - 1)) * (width - 4) + 2 : width / 2;
    const y = h - 3 - (v / max) * (h - 6);
    return [x, y] as const;
  });
  const last = pts[pts.length - 1];
  return (
    <div ref={ref} className="h-8 w-full" aria-hidden="true">
      {width > 0 && pts.length > 0 && (
        <svg width={width} height={h} className="block overflow-visible">
          <polyline
            points={pts.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke="#c7d2e3"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {last && <circle cx={last[0]} cy={last[1]} r={3.5} fill={color} stroke="#fff" strokeWidth={2} />}
        </svg>
      )}
    </div>
  );
}

// Линейный график по дням

export interface LineSeries {
  key: string;
  label: string;
  color: string;
}

export function LineChart({
  dates,
  series,
  values,
  height = 240,
}: {
  dates: string[];
  series: LineSeries[];
  /** values[s][i] - значение серии s в день i */
  values: number[][];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const pad = { top: 12, right: 44, bottom: 28, left: 40 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const n = dates.length;
  const max = Math.max(0, ...values.flat());
  const { top, step } = niceScale(max);
  const x = (i: number) => pad.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;

  const yTicks: number[] = [];
  for (let t = 0; t <= top; t += step) yTicks.push(t);

  const maxLabels = Math.max(2, Math.floor(plotW / 64));
  const every = Math.max(1, Math.ceil(n / maxLabels));
  const xTicks = dates
    .map((_, i) => i)
    .filter((i) => (n - 1 - i) % every === 0 && (i === n - 1 || n - 1 - i >= every * 0.6));

  function pick(clientX: number) {
    const el = ref.current;
    if (!el || n === 0) return;
    const left = el.getBoundingClientRect().left;
    const rel = (clientX - left - pad.left) / (plotW || 1);
    setHover(Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1)))));
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      setHover((h) => Math.min(n - 1, Math.max(0, (h ?? n - 1) + d)));
    } else if (e.key === 'Escape') {
      setHover(null);
    }
  }

  const tipLeft = hover !== null ? x(hover) : 0;
  const tipOnLeft = tipLeft > width * 0.6;

  return (
    <div
      ref={ref}
      className="relative w-full outline-none focus-visible:ring-2 focus-visible:ring-blue-200 rounded-lg"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={`График за ${n} дн.: ${series.map((s, k) => `${s.label} — всего ${fmtNum(values[k].reduce((a, b) => a + b, 0))}`).join('; ')}`}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerLeave={() => setHover(null)}
      onFocus={() => setHover(n - 1)}
      onBlur={() => setHover(null)}
      onKeyDown={onKey}
    >
      {width > 0 && (
        <svg width={width} height={height} className="block select-none">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={pad.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? CHART.axis : CHART.grid} />
              <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={CHART.muted} className="tabular-nums">
                {fmtNum(t)}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={height - 8} textAnchor="middle" fontSize={11} fill={CHART.muted}>
              {fmtDay(dates[i])}
            </text>
          ))}

          {series.map((s, k) => {
            const pts = values[k].map((v, i) => `${x(i)},${y(v)}`).join(' ');
            const area = `${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`;
            return (
              <g key={s.key}>
                {k === 0 && <polygon points={area} fill={s.color} opacity={0.08} />}
                <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}

          {/* Подписи на концах линий. Если наезжают друг на друга, раздвигаем
              вверх: внизу место занято подписями дат. */}
          {(() => {
            const ends = series
              .map((s, k) => ({ s, v: values[k][n - 1] ?? 0, yy: y(values[k][n - 1] ?? 0) }))
              .sort((a, b) => b.yy - a.yy);
            for (let i = 1; i < ends.length; i++) {
              if (ends[i - 1].yy - ends[i].yy < 14) ends[i].yy = ends[i - 1].yy - 14;
            }
            return ends.map(({ s, v, yy }) => (
              <text key={s.key} x={x(n - 1) + 8} y={yy} dy="0.32em" fontSize={11} fontWeight={600} fill="#334155">
                {fmtNum(v)}
              </text>
            ));
          })()}

          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} stroke="#94a3b8" />
              {series.map((s, k) => (
                <circle key={s.key} cx={x(hover)} cy={y(values[k][hover])} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}

      {hover !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-xl border border-gray-100 bg-white px-3 py-2 shadow-lg"
          style={tipOnLeft ? { right: width - tipLeft + 12 } : { left: tipLeft + 12 }}
        >
          <div className="text-[11px] font-semibold text-gray-400 mb-1">
            {fmtDay(dates[hover], { weekday: 'short', day: 'numeric', month: 'long' })}
          </div>
          {series.map((s, k) => (
            <div key={s.key} className="flex items-center gap-2 text-xs py-0.5">
              <span className="h-0.5 w-3 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="font-bold text-[#0f1c3f] tabular-nums">{fmtNum(values[k][hover])}</span>
              <span className="text-gray-500">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; kind?: 'line' | 'box' }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span
            className={it.kind === 'box' ? 'h-2.5 w-2.5 rounded-sm' : 'h-0.5 w-3.5 rounded-full'}
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// Горизонтальные столбцы

export function BarList({
  items,
  color = CHART.series1,
  empty = 'Нет данных за период',
}: {
  items: { key: string; label: string; value: number }[];
  color?: string;
  empty?: string;
}) {
  if (!items.length) return <p className="text-center text-gray-400 py-8 text-sm">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((it) => (
        <li key={it.key} className="group" title={`${it.label}: ${fmtNum(it.value)}`}>
          <div className="text-xs text-slate-600 truncate mb-1">{it.label}</div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2.5">
              <div
                className="h-full rounded-r-[4px] transition-opacity group-hover:opacity-80"
                style={{ width: `${Math.max(2, (it.value / max) * 100)}%`, background: color }}
              />
            </div>
            <span className="w-10 text-right text-xs font-bold text-[#0f1c3f] tabular-nums">{fmtNum(it.value)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// Составная полоса (часть от целого)

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
  icon?: LucideIcon;
}

export function StackedBar({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px] bg-gray-100">
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <div
                key={s.key}
                title={`${s.label}: ${fmtNum(s.value)}`}
                className="h-full transition-opacity hover:opacity-80"
                style={{ flexGrow: s.value, flexBasis: 0, background: s.color, minWidth: 4 }}
              />
            ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
        {segments.map(({ key, label, value, color, icon: Icon }) => (
          <span key={key} className="flex items-center gap-1.5 text-gray-500">
            {Icon ? <Icon size={14} style={{ color }} /> : <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />}
            {label}
            <span className="font-bold text-[#0f1c3f] tabular-nums">{fmtNum(value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// Тепловая карта "день недели x час"

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

export function Heatmap({ cells }: { cells: { dow: number; hour: number; count: number }[] }) {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const c of cells) {
    if (c.dow >= 1 && c.dow <= 7 && c.hour >= 0 && c.hour < 24) grid[c.dow - 1][c.hour] = c.count;
  }
  const max = Math.max(0, ...grid.flat());
  const [tip, setTip] = useState<{ d: number; h: number } | null>(null);

  const shade = (v: number) => {
    if (v <= 0 || max === 0) return HEAT_STEPS[0];
    const idx = Math.ceil((v / max) * (HEAT_STEPS.length - 1));
    return HEAT_STEPS[Math.min(HEAT_STEPS.length - 1, Math.max(1, idx))];
  };

  const busiest = (() => {
    let best = { d: 0, h: 0, v: 0 };
    grid.forEach((row, d) => row.forEach((v, h) => v > best.v && (best = { d, h, v })));
    return best;
  })();

  return (
    <div className="flex flex-col gap-3">
      <div
        className="relative"
        role="img"
        aria-label={
          max
            ? `Больше всего вопросов: ${WEEKDAYS_FULL[busiest.d]}, ${busiest.h}:00–${busiest.h + 1}:00 (${busiest.v})`
            : 'Вопросов за период нет'
        }
        onPointerLeave={() => setTip(null)}
      >
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: '24px repeat(24, minmax(0, 1fr))' }}>
          {grid.map((row, d) => (
            <div key={d} className="contents">
              <span className="text-[10px] text-gray-400 leading-none self-center">{WEEKDAYS[d]}</span>
              {row.map((v, h) => (
                <div
                  key={h}
                  onPointerEnter={() => setTip({ d, h })}
                  className={`relative aspect-square rounded-[3px] ${tip?.d === d && tip?.h === h ? 'ring-2 ring-[#0f1c3f]/40' : ''}`}
                  style={{ background: shade(v) }}
                >
                  {tip?.d === d && tip?.h === h && (
                    <div
                      className={`pointer-events-none absolute bottom-full mb-1.5 z-10 rounded-lg border border-gray-100 bg-white px-2.5 py-1.5 shadow-lg text-xs whitespace-nowrap ${
                        h < 4 ? 'left-0' : h > 19 ? 'right-0' : 'left-1/2 -translate-x-1/2'
                      }`}
                    >
                      <span className="font-bold text-[#0f1c3f] tabular-nums">{fmtNum(v)}</span>
                      <span className="text-gray-500">
                        {' '}
                        · {WEEKDAYS[d]}, {h}:00–{h + 1}:00
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-[10px] text-gray-400 text-center leading-none pt-1">
              {h % 3 === 0 ? h : ''}
            </span>
          ))}
        </div>

      </div>

      <div className="flex items-center gap-2 text-[11px] text-gray-400">
        <span>меньше</span>
        {HEAT_STEPS.map((c) => (
          <span key={c} className="h-2.5 w-4 rounded-[2px]" style={{ background: c }} />
        ))}
        <span>больше</span>
        {max > 0 && <span className="ml-auto">максимум — {fmtNum(max)} в час</span>}
      </div>
    </div>
  );
}
