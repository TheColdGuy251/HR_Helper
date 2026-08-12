'use client';
import { useEffect, type RefObject } from 'react';

/* Хуки под плавающий композер чата/мессенджера — порт scripts.js:654-714. */

/**
 * Подъём поля ввода из-под экранной клавиатуры (порт scripts.js:654-684).
 *
 * При открытии клавиатуры браузер сжимает visualViewport. Меряем, насколько
 * композер ушёл под клавиатуру, и ровно на столько поднимаем его вверх —
 * лента сообщений при этом остаётся на месте.
 *
 * Работает только на сенсорных устройствах (`pointer: coarse`): на десктопе
 * экранной клавиатуры нет, и композер ошибочно «уезжал» бы вверх.
 */
export function useKeyboardInset(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return;

    const node = ref.current;
    let raf: number | null = null;
    const apply = () => {
      raf = null;
      const el = ref.current;
      if (!el) return;
      el.style.transform = ''; // сброс — измеряем натуральное положение
      // Высота, «съеденная» клавиатурой. Мала (<80px) — клавиатуры нет.
      const kb = window.innerHeight - vv.height - vv.offsetTop;
      if (kb < 80) return;
      const rect = el.getBoundingClientRect();
      const overlap = rect.bottom - (vv.offsetTop + vv.height); // ушло под клавиатуру
      if (overlap > 1) el.style.transform = `translateY(${-Math.round(overlap)}px)`;
    };
    const schedule = () => {
      if (raf == null) raf = requestAnimationFrame(apply);
    };

    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('orientationchange', schedule);
    schedule();
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('orientationchange', schedule);
      if (node) node.style.transform = '';
    };
  }, [ref]);
}

/**
 * Отступ ленты под плавающим композером (порт scripts.js:686-714).
 *
 * Фиксированный отступ был больше реальной высоты поля на телефоне — под ним
 * оставалась пустая прокручиваемая «кромка». Считаем по фактической высоте:
 * ResizeObserver на композере → paddingBottom ленты = height + gap.
 */
export function useComposerPadding(
  listRef: RefObject<HTMLElement | null>,
  composerRef: RefObject<HTMLElement | null>,
  gap = 12,
) {
  useEffect(() => {
    let raf: number | null = null;
    const sync = () => {
      raf = null;
      const list = listRef.current;
      const composer = composerRef.current;
      if (!list || !composer) return;
      list.style.paddingBottom = `${composer.offsetHeight + gap}px`;
    };
    const run = () => {
      if (raf == null) raf = requestAnimationFrame(sync);
    };

    run();
    window.addEventListener('resize', run);
    window.addEventListener('orientationchange', run);
    // Высота поля меняется: многострочный ввод, вложения, «Частые вопросы».
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && composerRef.current) {
      ro = new ResizeObserver(run);
      ro.observe(composerRef.current);
    }
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      window.removeEventListener('resize', run);
      window.removeEventListener('orientationchange', run);
      ro?.disconnect();
    };
  }, [listRef, composerRef, gap]);
}
