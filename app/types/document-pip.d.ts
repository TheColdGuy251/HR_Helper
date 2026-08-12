// Document Picture-in-Picture API (Chromium 116+). В lib.dom.d.ts его пока нет,
// поэтому описываем то, что используем в components/messenger/widget.tsx —
// вынос миничата в плавающее окно поверх всех приложений.

interface DocumentPictureInPictureOptions {
  /** Ширина окна в CSS-пикселях. */
  width?: number;
  /** Высота окна в CSS-пикселях. */
  height?: number;
  /** Скрыть кнопку «вернуться на вкладку». */
  disallowReturnToOpener?: boolean;
  /** Открыть на месте по умолчанию, а не там, где было прошлое окно. */
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPictureInPicture extends EventTarget {
  /** Открытое PiP-окно или null, если его нет. */
  readonly window: Window | null;
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
}

interface Window {
  /** Есть только в Chromium-браузерах; в остальных — undefined. */
  readonly documentPictureInPicture?: DocumentPictureInPicture;
}
