'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { MessagesSquare, Maximize2, Pin, PinOff, PictureInPicture2, X } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { Conversations } from './conversations';
import { Thread } from './thread';
import type { ActiveConv, ConversationsData, Msg } from './types';

// Плавающий мини-мессенджер (порт #msgrFab / #msgrPanel из messenger.js +
// templates/base.html): FAB, панель «список ↔ тред», счётчик непрочитанного,
// мобильный мост, вынос панели в отдельное окно (messenger.js:195-247),
// перетаскивание за шапку (messenger.js:304), ресайз за углы (messenger.js:249)
// и «булавка» (messenger.js:149).
//
// Состояние живёт в localStorage с ключами легаси:
//   msgrWidgetState — {open, conv:{key,peerId,general,name,…}}
//   mpLastConv      — последняя беседа для страницы /messenger
//   msgrPanelSize   — {w,h} размер панели
//   msgrPanelPos    — {left,top} положение панели
//   msgrPinned      — «1»/«0», закреплена ли панель

const STATE_KEY = 'msgrWidgetState';
const LAST_CONV_KEY = 'mpLastConv';
const SIZE_KEY = 'msgrPanelSize';
const POS_KEY = 'msgrPanelPos';
const PINNED_KEY = 'msgrPinned';
const MOBILE_QUERY = '(max-width: 900px)';
const POPUP_FEATURES =
  'width=430,height=680,menubar=no,toolbar=no,location=no,status=no,resizable=yes';

const MIN_W = 320; // минимальные размеры панели — как в легаси
const MIN_H = 380;
const DRAG_SLOP = 4; // порог, отличающий перетаскивание от клика
const REOPEN_GUARD_MS = 350; // клик, открывший панель / завершивший drag-resize
const DBL_CLICK_MS = 300; // двойной клик по FAB сбрасывает положение и размер

interface StoredState {
  open?: boolean;
  conv?: ActiveConv | null;
}

interface PanelSize {
  w: number;
  h: number;
}
interface PanelPos {
  left: number;
  top: number;
}

type ResizeDir = 'nw' | 'ne' | 'sw' | 'se';

interface DragState {
  x: number;
  y: number;
  left: number;
  top: number;
  active: boolean;
}

interface ResizeState {
  dir: ResizeDir;
  sx: number;
  sy: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  w: number;
  h: number;
}

/** Ручки ресайза по углам: положение + курсор. */
const RESIZE_HANDLES: { dir: ResizeDir; cls: string }[] = [
  { dir: 'nw', cls: 'top-0 left-0 cursor-nwse-resize' },
  { dir: 'ne', cls: 'top-0 right-0 cursor-nesw-resize' },
  { dir: 'sw', cls: 'bottom-0 left-0 cursor-nesw-resize' },
  { dir: 'se', cls: 'bottom-0 right-0 cursor-nwse-resize' },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function readJson<T>(key: string): T | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    return raw && typeof raw === 'object' ? (raw as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватный режим */
  }
}

function readState(): StoredState | null {
  return readJson<StoredState>(STATE_KEY);
}

function writeState(open: boolean, conv: ActiveConv | null) {
  writeJson(STATE_KEY, { open, conv });
}

/** Снимок для /messenger — поля как у страницы (peer_key/peer_id). */
function rememberConv(conv: ActiveConv) {
  writeJson(LAST_CONV_KEY, {
    key: conv.key,
    peer_key: conv.key,
    peer_id: conv.peerId,
    general: conv.general,
    is_general: conv.general,
    name: conv.name,
    initials: conv.initials,
    position: conv.position,
  });
}

/** Готовим документ PiP-окна: стили приложения, тема, заголовок (moveToPip). */
function dressPipWindow(win: Window) {
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((n) => {
    try {
      win.document.head.appendChild(n.cloneNode(true));
    } catch {
      /* стиль с другого origin — пропускаем */
    }
  });
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme) win.document.documentElement.setAttribute('data-theme', theme);
  win.document.body.style.margin = '0';
  win.document.body.style.background = '#f4f7fc';
  win.document.title = 'Сообщения';
}

export function MessengerWidget() {
  const pathname = usePathname();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ActiveConv | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [mobile, setMobile] = useState(false);
  const [pip, setPip] = useState<Window | null>(null);
  // Положение/размер панели и «булавка» — восстанавливаются из localStorage.
  const [pos, setPos] = useState<PanelPos | null>(null);
  const [size, setSize] = useState<PanelSize | null>(null);
  const [pinned, setPinned] = useState(false);
  // Узел-контейнер панели: живёт вне корня приложения и целиком переезжает
  // между документами (appendChild) — см. комментарий у портала в render.
  const [host] = useState<HTMLDivElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('div')
  );

  const panelRef = useRef<HTMLDivElement>(null);
  const pipRef = useRef<Window | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  // Метка последнего открытия / конца drag-resize: клик, их завершивший, не
  // должен тут же закрыть незакреплённую панель.
  const lastOpenRef = useRef(0);

  // Зеркала состояния для обработчика SSE, живущего всё время работы страницы.
  const openRef = useRef(false);
  const activeRef = useRef<ActiveConv | null>(null);
  useEffect(() => {
    openRef.current = open;
    activeRef.current = active;
  }, [open, active]);

  useEffect(() => {
    pipRef.current = pip;
  }, [pip]);

  useEffect(() => {
    if (!host) return;
    document.body.appendChild(host);
    return () => host.remove();
  }, [host]);

  // Уход со страницы/размонтирование виджета — закрываем осиротевшее PiP-окно.
  useEffect(
    () => () => {
      try {
        pipRef.current?.close();
      } catch {
        /* окно уже закрыто */
      }
    },
    []
  );

  // На /messenger виджет не нужен — там полноценная страница.
  const hidden = pathname === '/messenger' || pathname.startsWith('/messenger/');

  // ── ширина экрана: <900px → вместо панели переходим на страницу ────────────
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Панель пропала (узкий экран или переход на /messenger) — закрываем и окно,
  // иначе останется висеть пустым.
  useEffect(() => {
    if (!mobile && !hidden) return;
    try {
      pipRef.current?.close();
    } catch {
      /* окно уже закрыто */
    }
    if (host && host.ownerDocument !== document) document.body.appendChild(host);
    setPip(null);
  }, [mobile, hidden, host]);

  // ── счётчик непрочитанного ────────────────────────────────────────────────
  const loadUnread = useCallback(async () => {
    try {
      const d = await apiGet<ConversationsData>('/api/messenger/conversations');
      const map: Record<string, number> = {};
      if (d.general) map[d.general.key] = d.general.unread || 0;
      d.users.forEach((u) => {
        map[u.key] = u.unread || 0;
      });
      setUnread(map);
    } catch {
      /* счётчик не критичен */
    }
  }, []);

  useEffect(() => {
    if (hidden) return;
    void loadUnread();
  }, [hidden, loadUnread]);

  // Новое сообщение коллеги увеличивает счётчик сразу (как в легаси).
  useEffect(() => {
    if (hidden) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadUnread(), 600);
    };
    const onMessage = (e: Event) => {
      const m = (e as CustomEvent<Msg>).detail;
      const key = m?.peer_key;
      if (!m || m.mine || m.system || !key) return;
      // Открытый в панели тред сам отметит прочтение.
      if (openRef.current && activeRef.current?.key === key) return;
      setUnread((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
    };
    window.addEventListener('hr:user-message', onMessage);
    window.addEventListener('hr:user-read', bump);
    window.addEventListener('hr:unread-changed', bump);
    return () => {
      window.removeEventListener('hr:user-message', onMessage);
      window.removeEventListener('hr:user-read', bump);
      window.removeEventListener('hr:unread-changed', bump);
      if (timer) clearTimeout(timer);
    };
  }, [hidden, loadUnread]);

  // ── восстановление состояния панели ───────────────────────────────────────
  useEffect(() => {
    if (hidden || mobile) return;
    const st = readState();
    if (!st?.open) return;
    setOpen(true);
    lastOpenRef.current = Date.now();
    if (st.conv?.key) setActive(st.conv);
    // Только при первом появлении виджета на странице.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  // ── геометрия панели: восстановление, перетаскивание, ресайз ───────────────

  useEffect(() => {
    const s = readJson<PanelSize>(SIZE_KEY);
    if (s && typeof s.w === 'number' && typeof s.h === 'number') setSize(s);
    const p = readJson<PanelPos>(POS_KEY);
    if (p && typeof p.left === 'number' && typeof p.top === 'number') setPos(p);
    try {
      setPinned(localStorage.getItem(PINNED_KEY) === '1');
    } catch {
      /* приватный режим */
    }
  }, []);

  // Сохранённое положение могло остаться за пределами окна (другой монитор) —
  // заводим панель обратно в видимую область при её появлении.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || pip || !pos) return;
    const left = clamp(pos.left, 0, Math.max(0, window.innerWidth - el.offsetWidth));
    const top = clamp(pos.top, 0, Math.max(0, window.innerHeight - el.offsetHeight));
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
    // Только при открытии панели / возврате из отдельного окна.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pip]);

  /** Начало перетаскивания — только по шапке и не по её кнопкам (messenger.js:330). */
  const onPanelMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || pip) return;
    const t = e.target;
    if (!(t instanceof Element) || !t.closest('[data-msgr-head]')) return;
    if (t.closest('button, a, input, textarea, select')) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, active: false };
  };

  const startResize = (e: React.MouseEvent<HTMLDivElement>, dir: ResizeDir) => {
    if (e.button !== 0 || pip) return;
    e.preventDefault();
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Тянем угол — противоположный остаётся на месте, поэтому запоминаем весь
    // исходный прямоугольник.
    resizeRef.current = {
      dir,
      sx: e.clientX,
      sy: e.clientY,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      w: r.width,
      h: r.height,
    };
    document.body.style.userSelect = 'none';
  };

  // Само движение ведём через style элемента, а не через состояние: перерисовка
  // треда на каждый mousemove слишком дорога. В состояние и localStorage
  // результат уходит один раз — на mouseup.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = panelRef.current;
      if (!el) return;

      const rz = resizeRef.current;
      if (rz) {
        const dx = e.clientX - rz.sx;
        const dy = e.clientY - rz.sy;
        let left = rz.left;
        let top = rz.top;
        let w = rz.w;
        let h = rz.h;
        if (rz.dir.includes('e')) w = clamp(rz.w + dx, MIN_W, window.innerWidth - rz.left);
        if (rz.dir.includes('w')) {
          w = clamp(rz.w - dx, MIN_W, rz.right);
          left = rz.right - w;
        }
        if (rz.dir.includes('s')) h = clamp(rz.h + dy, MIN_H, window.innerHeight - rz.top);
        if (rz.dir.includes('n')) {
          h = clamp(rz.h - dy, MIN_H, rz.bottom);
          top = rz.bottom - h;
        }
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.maxWidth = 'none';
        el.style.maxHeight = 'none';
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        return;
      }

      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.active) {
        if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
        d.active = true;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }
      el.style.left = `${clamp(d.left + dx, 0, window.innerWidth - el.offsetWidth)}px`;
      el.style.top = `${clamp(d.top + dy, 0, window.innerHeight - el.offsetHeight)}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };

    const onUp = () => {
      const el = panelRef.current;
      const wasResize = !!resizeRef.current;
      const wasDrag = !!dragRef.current?.active;
      resizeRef.current = null;
      dragRef.current = null;
      if (!wasResize && !wasDrag) return;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      lastOpenRef.current = Date.now();
      if (!el) return;
      const r = el.getBoundingClientRect();
      const nextPos = { left: Math.round(r.left), top: Math.round(r.top) };
      setPos(nextPos);
      writeJson(POS_KEY, nextPos);
      if (wasResize) {
        const nextSize = { w: Math.round(r.width), h: Math.round(r.height) };
        setSize(nextSize);
        writeJson(SIZE_KEY, nextSize);
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const total = Object.values(unread).reduce((a, b) => a + (b || 0), 0);

  const goToPage = (conv?: ActiveConv | null) => {
    try {
      sessionStorage.setItem('msgrReturnUrl', window.location.pathname + window.location.search);
      if (conv) {
        sessionStorage.setItem(
          'msgrOpenConv',
          JSON.stringify({
            key: conv.key,
            peer_key: conv.key,
            peer_id: conv.peerId,
            general: conv.general,
            is_general: conv.general,
            name: conv.name,
            initials: conv.initials,
            position: conv.position,
          })
        );
      }
    } catch {
      /* приватный режим */
    }
    router.push('/messenger');
  };

  const pick = (c: ActiveConv) => {
    setActive(c);
    setUnread((prev) => ({ ...prev, [c.key]: 0 }));
    rememberConv(c);
    writeState(true, c);
  };

  const back = () => {
    setActive(null);
    writeState(true, null);
  };

  /** Возврат панели на страницу (порт restoreFromPip, messenger.js:213). */
  const restoreFromPip = useCallback(() => {
    if (host && host.ownerDocument !== document) document.body.appendChild(host);
    setPip(null);
  }, [host]);

  const close = useCallback(() => {
    try {
      pipRef.current?.close(); // панель свернули — отдельное окно тоже не нужно
    } catch {
      /* окно уже закрыто */
    }
    restoreFromPip();
    setOpen(false);
    writeState(false, active);
  }, [restoreFromPip, active]);

  /** Сброс к размерам и положению по умолчанию (порт resetPanel, messenger.js:120). */
  const resetPanel = () => {
    setPos(null);
    setSize(null);
    try {
      localStorage.removeItem(SIZE_KEY);
      localStorage.removeItem(POS_KEY);
    } catch {
      /* приватный режим */
    }
    if (!open) {
      setOpen(true);
      lastOpenRef.current = Date.now();
      writeState(true, active);
    }
  };

  const togglePinned = () => {
    const next = !pinned;
    setPinned(next);
    try {
      localStorage.setItem(PINNED_KEY, next ? '1' : '0');
    } catch {
      /* приватный режим */
    }
  };

  // Незакреплённая панель закрывается кликом мимо (порт messenger.js:168).
  // Решение принимаем на mousedown: к моменту click узел мог уже исчезнуть из
  // DOM (закрылось меню сообщения) и closest() ничего бы не нашёл.
  // Легаси перечисляло свои оверлеи поимённо (.msgr-modal-ov, .toast-container,
  // …); здесь вместо списка классов — общее правило: клики по любому плавающему
  // слою (position: fixed) панель не закрывают. Так тосты и модалки, живущие
  // вне поддерева панели, её не гасят.
  const keepOpenRef = useRef(false);
  useEffect(() => {
    if (!open || mobile || pinned || pip) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) {
        keepOpenRef.current = true;
        return;
      }
      if (t.closest('[data-msgr-panel], [data-msgr-fab]')) {
        keepOpenRef.current = true;
        return;
      }
      let floating = false;
      for (let n: Element | null = t; n && !floating; n = n.parentElement) {
        floating = getComputedStyle(n).position === 'fixed';
      }
      keepOpenRef.current = floating;
    };
    const onClick = () => {
      if (keepOpenRef.current) return;
      if (Date.now() - lastOpenRef.current < REOPEN_GUARD_MS) return;
      close();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('click', onClick);
    };
  }, [open, mobile, pinned, pip, close]);

  // Одиночный клик по FAB открывает/сворачивает, двойной — сбрасывает геометрию.
  const lastFabClickRef = useRef(0);
  const toggle = () => {
    if (mobile) {
      goToPage();
      return;
    }
    const now = Date.now();
    if (now - lastFabClickRef.current < DBL_CLICK_MS) {
      lastFabClickRef.current = 0;
      resetPanel();
      return;
    }
    lastFabClickRef.current = now;
    if (open) {
      close();
      return;
    }
    setOpen(true);
    lastOpenRef.current = now;
    writeState(true, active);
  };

  // ── вынос панели в отдельное окно (порт popOut, messenger.js:218) ──────────
  const popOut = async () => {
    const dpip = window.documentPictureInPicture;
    if (dpip && typeof dpip.requestWindow === 'function' && host) {
      const r = panelRef.current?.getBoundingClientRect();
      try {
        const win = await dpip.requestWindow({
          width: Math.round(r?.width || 0) || 400,
          height: Math.round(r?.height || 0) || 620,
        });
        dressPipWindow(win);
        // Переносим сам узел: React-дерево не меняется, поэтому состояние треда,
        // подписки на SSE и делегированные обработчики остаются живыми.
        win.document.body.appendChild(host);
        win.addEventListener('pagehide', restoreFromPip, { once: true });
        setPip(win);
        return;
      } catch {
        restoreFromPip(); // API есть, но окно не открылось — идём в обычное окно
      }
    }
    // Фолбэк: обычное окно браузера. sessionStorage туда не переносится, поэтому
    // текущую беседу кладём в localStorage — /messenger поднимет её из mpLastConv.
    if (active) rememberConv(active);
    setOpen(false);
    writeState(false, active);
    const w = window.open('/messenger?popup=1', 'hrMessenger', POPUP_FEATURES);
    if (w) {
      w.focus();
    } else {
      setOpen(true); // popup заблокирован — возвращаем панель
      writeState(true, active);
    }
  };

  if (hidden) return null;

  // Своя геометрия перебивает классы по умолчанию; в отдельном окне панель
  // всегда во весь экран, поэтому там стилей нет.
  // ВНИМАНИЕ: геометрия панели НЕ передаётся в style у React.
  //
  // Перетаскивание и ресайз ведутся императивно (el.style.left/top/width) ради
  // производительности — setState на каждый mousemove перерисовывал бы всю
  // ленту сообщений. Если те же свойства заодно приходили бы из React-стиля,
  // любой ререндер во время жеста (SSE, счётчик непрочитанных, набор текста)
  // возвращал бы панель на сохранённое место — со стороны это выглядело как
  // «панель не двигается». Поэтому сохранённые left/top/width/height
  // применяются эффектом ниже, а style остаётся пустым.
  // Сохранённая геометрия. Во время жеста панель двигается императивно
  // (el.style.*), а сюда попадает только итог по mouseup: React в это время
  // ререндерится с теми же pos/size, поэтому инлайн-стиль жест не перебивает.
  const panelStyle: React.CSSProperties | undefined = pip
    ? undefined
    : {
        ...(size ? { width: size.w, height: size.h, maxWidth: 'none', maxHeight: 'none' } : null),
        ...(pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : null),
      };

  /** Кнопка-«булавка»: закреплённая панель не закрывается кликом мимо. */
  const pinButton = (cls: string) => (
    <button
      onClick={togglePinned}
      title={
        pinned
          ? 'Открепить: закрывать при клике вне окна'
          : 'Закрепить: не закрывать при клике вне окна'
      }
      className={`${cls} ${pinned ? 'text-[#2563eb] bg-blue-50' : 'text-gray-400'}`}
    >
      {pinned ? <Pin size={14} /> : <PinOff size={14} />}
    </button>
  );

  const panel = (
    <div
      ref={panelRef}
      data-msgr-panel
      style={panelStyle}
      onMouseDown={onPanelMouseDown}
      className={
        pip
          ? 'fixed inset-0 flex flex-col bg-[#f4f7fc]'
          : 'fixed right-4 sm:right-6 bottom-24 z-[80] w-[380px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[calc(100vh-9rem)] flex flex-col drop-shadow-2xl'
      }
    >
      {/* ручки изменения размера по углам (в отдельном окне не нужны) */}
      {!pip &&
        RESIZE_HANDLES.map((h) => (
          <div
            key={h.dir}
            onMouseDown={(e) => startResize(e, h.dir)}
            className={`absolute w-4 h-4 z-10 ${h.cls}`}
          />
        ))}

      {active ? (
        <Thread
          key={active.key}
          conv={active}
          onBack={back}
          compact
          headerExtra={
            <div className="flex items-center gap-1 shrink-0">
              {!pip &&
                pinButton('p-2 rounded-lg hover:text-[#2563eb] hover:bg-white transition')}
              {!pip && (
                <button
                  onClick={popOut}
                  title="Вынести в отдельное окно"
                  className="p-2 rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-white transition"
                >
                  <PictureInPicture2 size={14} />
                </button>
              )}
              <button
                onClick={() => goToPage(active)}
                title="Открыть в мессенджере"
                className="p-2 rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-white transition"
              >
                <Maximize2 size={14} />
              </button>
              <button
                onClick={close}
                title="Свернуть"
                className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-white transition"
              >
                <X size={14} />
              </button>
            </div>
          }
        />
      ) : (
        <Conversations
          active={null}
          onSelect={pick}
          autoRestore={false}
          headerExtra={
            <>
              {!pip &&
                pinButton('p-1.5 rounded-lg hover:text-[#2563eb] hover:bg-gray-50 transition')}
              {!pip && (
                <button
                  onClick={popOut}
                  title="Вынести в отдельное окно"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-gray-50 transition"
                >
                  <PictureInPicture2 size={14} />
                </button>
              )}
              <button
                onClick={() => goToPage()}
                title="Открыть мессенджер"
                className="p-1.5 rounded-lg text-gray-400 hover:text-[#2563eb] hover:bg-gray-50 transition"
              >
                <Maximize2 size={14} />
              </button>
              <button
                onClick={close}
                title="Свернуть"
                className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-gray-50 transition"
              >
                <X size={14} />
              </button>
            </>
          }
        />
      )}
    </div>
  );

  return (
    <>
      {/* Портал в собственный узел-контейнер: React вешает делегированные
          слушатели именно на контейнер портала, и они переезжают вместе с ним
          в PiP-окно. Так панель остаётся в дереве React (состояние и SSE целы),
          а в другой документ уезжает живой DOM-узел, а не копия. */}
      {open && !mobile && host && createPortal(panel, host)}

      <button
        onClick={toggle}
        data-msgr-fab
        title={pip ? 'Закрыть окно чата' : open && !mobile ? 'Свернуть чат' : 'Чат с коллегами'}
        aria-label="Мессенджер"
        className="fixed right-4 sm:right-6 bottom-6 z-[80] w-14 h-14 rounded-full bg-[#2563eb] text-white flex items-center justify-center shadow-xl shadow-blue-500/30 hover:bg-[#1e40af] transition"
      >
        {open && !mobile ? <X size={22} /> : <MessagesSquare size={22} />}
        {total > 0 && !(open && !mobile) && (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-[20px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-[#f4f7fc]">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>
    </>
  );
}
