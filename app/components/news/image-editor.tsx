'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Crop, RefreshCcw, RotateCcw, RotateCw, X } from 'lucide-react';
import { apiUpload } from '@/lib/api';
import { PrimaryButton, SecondaryButton } from '@/components/ui';

// Встроенный редактор картинки новости — порт news.js:394-530
// (ieDraw / loadIntoCanvas / openImageEditor / rotate / stageToCanvas).
// Поворот ±90°, обрезка выделением мыши, масштаб 10–100 %, сброс.
// Итог уходит в существующий POST /api/news/upload (поле file), форма запроса та же.

/** Ответ POST /api/news/upload → {success, media}. */
interface UploadedMedia {
  id: number;
  name: string;
  size: number;
  is_image: boolean;
  url: string;
}

/** Прямоугольник выделения в пикселях холста (не экрана). */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ToolBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium text-slate-500 hover:bg-white hover:text-[#2563eb] hover:shadow-sm transition disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:shadow-none"
    >
      {children}
    </button>
  );
}

export default function NewsImageEditor({
  src,
  onCancel,
  onApply,
}: {
  /** Адрес редактируемой картинки (та, что в теле поста). */
  src: string;
  onCancel: () => void;
  /** Новый адрес после загрузки + ширина результата в пикселях. */
  onApply: (url: string, width: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStop = useRef<(() => void) | null>(null);

  const [crop, setCrop] = useState<Rect | null>(null);
  const [scale, setScale] = useState(100);
  const [size, setSize] = useState({ w: 0, h: 0 }); // размеры холста (полное разрешение)
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; err?: boolean } | null>(null);

  /** Загрузить изображение в холст: холст всегда хранит полное разрешение. */
  const loadIntoCanvas = useCallback(
    (source: string) =>
      new Promise<void>((resolve, reject) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => {
          const c = canvasRef.current;
          if (!c) {
            resolve();
            return;
          }
          c.width = im.naturalWidth || im.width;
          c.height = im.naturalHeight || im.height;
          const ctx = c.getContext('2d');
          if (!ctx) {
            reject(new Error('Холст недоступен'));
            return;
          }
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.drawImage(im, 0, 0);
          setSize({ w: c.width, h: c.height });
          setCrop(null);
          setReady(true);
          resolve();
        };
        im.onerror = () => reject(new Error('Не удалось загрузить изображение'));
        im.src = source;
      }),
    []
  );

  // Первичная загрузка. Прокрутку body уже блокирует редактор новости.
  useEffect(() => {
    loadIntoCanvas(src).catch((e: unknown) => setStatus({ text: errMsg(e), err: true }));
    return () => {
      dragStop.current?.();
    };
  }, [src, loadIntoCanvas]);

  // Esc закрывает редактор картинки (сам пост остаётся открытым).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  /** Экранные координаты → пиксели холста (порт stageToCanvas). */
  const toCanvas = (clientX: number, clientY: number): { x: number; y: number } => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    const sx = c.width / r.width;
    const sy = c.height / r.height;
    return {
      x: clamp((clientX - r.left) * sx, 0, c.width),
      y: clamp((clientY - r.top) * sy, 0, c.height),
    };
  };

  /** Выделение области обрезки протяжкой мыши. */
  const startCrop = (e: React.MouseEvent) => {
    if (!ready || busy) return;
    e.preventDefault();
    const start = toCanvas(e.clientX, e.clientY);
    setCrop({ x: start.x, y: start.y, w: 0, h: 0 });
    const move = (ev: MouseEvent) => {
      const p = toCanvas(ev.clientX, ev.clientY);
      setCrop({
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      });
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      dragStop.current = null;
    };
    dragStop.current = stop;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  };

  /** Поворот на 90° через временный холст (порт rotate). */
  const rotate = (dir: 'l' | 'r') => {
    const c = canvasRef.current;
    if (!c || !ready) return;
    const w = c.width;
    const h = c.height;
    const tmp = document.createElement('canvas');
    tmp.width = h;
    tmp.height = w;
    const tctx = tmp.getContext('2d');
    if (!tctx) return;
    tctx.translate(h / 2, w / 2);
    tctx.rotate(((dir === 'r' ? 90 : -90) * Math.PI) / 180);
    tctx.drawImage(c, -w / 2, -h / 2);
    void loadIntoCanvas(tmp.toDataURL('image/png')).catch(() => undefined);
  };

  /** Обрезка по выделению. */
  const applyCrop = () => {
    const c = canvasRef.current;
    if (!c || !ready) return;
    if (!crop || crop.w < 5 || crop.h < 5) {
      setStatus({ text: 'Сначала выделите область.', err: true });
      return;
    }
    const tmp = document.createElement('canvas');
    tmp.width = Math.round(crop.w);
    tmp.height = Math.round(crop.h);
    const tctx = tmp.getContext('2d');
    if (!tctx) return;
    tctx.drawImage(c, crop.x, crop.y, crop.w, crop.h, 0, 0, tmp.width, tmp.height);
    setStatus(null);
    void loadIntoCanvas(tmp.toDataURL('image/png')).catch(() => undefined);
  };

  /** Сброс: заново грузим исходную картинку. */
  const reset = () => {
    setScale(100);
    setStatus(null);
    loadIntoCanvas(src).catch((e: unknown) => setStatus({ text: errMsg(e), err: true }));
  };

  const outW = Math.max(1, Math.round(size.w * clamp(scale / 100, 0.1, 1)));
  const outH = Math.max(1, Math.round(size.h * clamp(scale / 100, 0.1, 1)));

  /** Применить: масштабируем, экспортируем PNG, грузим как новое media. */
  const apply = async () => {
    const c = canvasRef.current;
    if (!c || !ready || busy) return;
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const octx = out.getContext('2d');
    if (!octx) return;
    octx.drawImage(c, 0, 0, outW, outH);

    setBusy(true);
    setStatus({ text: 'Сохранение…' });
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
    if (!blob) {
      setBusy(false);
      setStatus({ text: 'Не удалось подготовить изображение.', err: true });
      return;
    }
    try {
      const ext = /png/i.test(blob.type) ? 'png' : 'jpg';
      const file = new File([blob], `image.${ext}`, { type: blob.type });
      const fd = new FormData();
      fd.append('file', file);
      const d = await apiUpload<{ success: boolean; media: UploadedMedia }>('/api/news/upload', fd);
      onApply(d.media.url, outW);
    } catch (e) {
      setBusy(false);
      setStatus({ text: 'Ошибка: ' + errMsg(e), err: true });
    }
  };

  // Рамка выделения — в процентах от холста, поэтому не зависит от масштаба показа.
  const cropStyle: React.CSSProperties | null =
    crop && size.w && size.h
      ? {
          left: `${(crop.x / size.w) * 100}%`,
          top: `${(crop.y / size.h) * 100}%`,
          width: `${(crop.w / size.w) * 100}%`,
          height: `${(crop.h / size.h) * 100}%`,
        }
      : null;

  return (
    <div
      className="fixed inset-0 z-[96] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="bg-white w-full max-w-3xl max-h-[92vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Редактирование изображения"
      >
        {/* Шапка */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <span className="font-bold text-[#0f1c3f]">Редактирование изображения</span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Закрыть"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-slate-700 hover:bg-gray-100 transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Тело */}
        <div className="px-6 py-5 overflow-y-auto flex-1 flex flex-col gap-4">
          {/* Панель инструментов */}
          <div className="flex flex-wrap items-center gap-1 p-1.5 bg-gray-50 border border-gray-100 rounded-xl">
            <ToolBtn title="Повернуть влево" onClick={() => rotate('l')} disabled={!ready || busy}>
              <RotateCcw size={15} />
            </ToolBtn>
            <ToolBtn title="Повернуть вправо" onClick={() => rotate('r')} disabled={!ready || busy}>
              <RotateCw size={15} />
            </ToolBtn>
            <ToolBtn title="Обрезать по выделению" onClick={applyCrop} disabled={!ready || busy}>
              <Crop size={15} /> Обрезать
            </ToolBtn>
            <ToolBtn title="Вернуть исходное изображение" onClick={reset} disabled={busy}>
              <RefreshCcw size={15} /> Сброс
            </ToolBtn>

            <span className="w-px h-5 bg-gray-200 mx-1" aria-hidden />

            <label className="flex items-center gap-2 text-[13px] font-medium text-slate-500 px-1">
              Размер
              <input
                type="range"
                min={10}
                max={100}
                value={scale}
                disabled={busy}
                onChange={(e) => setScale(Number(e.target.value))}
                className="w-32 accent-[#2563eb] cursor-pointer"
                aria-label="Масштаб изображения"
              />
              <span className="w-10 tabular-nums text-slate-600">{scale}%</span>
            </label>
          </div>

          {/* Холст с рамкой выделения */}
          <div className="flex items-center justify-center bg-gray-50 border border-gray-100 rounded-xl p-3 overflow-auto">
            <div className="relative inline-block max-w-full leading-none">
              <canvas
                ref={canvasRef}
                onMouseDown={startCrop}
                className="block max-w-full h-auto rounded-lg select-none cursor-crosshair"
                style={{ maxHeight: '46vh' }}
              />
              {cropStyle && (
                <div
                  className="absolute border-2 border-dashed border-[#2563eb] bg-[#2563eb]/10 pointer-events-none rounded-sm"
                  style={cropStyle}
                />
              )}
            </div>
          </div>

          <p className="text-[13px] text-gray-400">
            Потяните рамку на изображении, чтобы выделить область для обрезки.
            {ready && (
              <>
                {' '}
                Исходник {size.w}×{size.h} px
                {scale !== 100 ? ` → будет сохранено ${outW}×${outH} px` : ''}.
              </>
            )}
          </p>

          {status && (
            <p className={`text-[13px] font-medium ${status.err ? 'text-red-500' : 'text-gray-500'}`}>
              {status.text}
            </p>
          )}
        </div>

        {/* Подвал */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100">
          <SecondaryButton onClick={onCancel} disabled={busy}>
            Отмена
          </SecondaryButton>
          <PrimaryButton onClick={apply} disabled={!ready || busy}>
            {busy ? 'Сохранение…' : 'Применить'}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
