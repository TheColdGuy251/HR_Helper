'use client';
import { useEffect } from 'react';

// Скроллбар виден не всегда: класс scroll-visible на <html> включает окраску
// ползунка (стили — в globals.css), а этот компонент решает, когда его вешать.
//
// Показываем в двух случаях:
//   1) страницу или любой внутренний список листают — прокрутку ловим в фазе
//      захвата, иначе события вложенных контейнеров (лента чата, список бесед)
//      до window не всплывают;
//   2) курсор подошёл к правому краю окна — там, где скроллбар и находится.
//
// Прячем через паузу после последнего события. Пауза общая: если курсор стоит
// у правого края, таймер продлевается движением мыши, поэтому ползунок не
// исчезает под рукой.

const HIDE_DELAY_MS = 1200;
/** Полоса у правого края, в которой скроллбар считается «под курсором». */
const EDGE_PX = 48;

export function ScrollbarAutoHide() {
  useEffect(() => {
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pinned = false; // курсор в правой полосе — не прячем

    const hide = () => {
      if (pinned) return;
      root.classList.remove('scroll-visible');
    };

    const show = () => {
      root.classList.add('scroll-visible');
      if (timer) clearTimeout(timer);
      timer = setTimeout(hide, HIDE_DELAY_MS);
    };

    const onScroll = () => show();

    const onMove = (e: MouseEvent) => {
      const nearEdge = window.innerWidth - e.clientX <= EDGE_PX;
      if (nearEdge) {
        pinned = true;
        show();
      } else if (pinned) {
        pinned = false;
        show(); // даём ползунку доиграть и погаснуть по таймеру
      }
    };

    // Курсор ушёл из окна — держать ползунок не за чем.
    const onLeave = () => {
      pinned = false;
      show();
    };

    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseleave', onLeave);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
      root.classList.remove('scroll-visible');
    };
  }, []);

  return null;
}
