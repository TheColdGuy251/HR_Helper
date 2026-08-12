'use client';
import { useEffect } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import type { MsgAttachment } from './types';

// Предпросмотр вложения (порт filePreview из messenger_common.js:833).
// Картинки — <img>, pdf/txt/md/csv — встроенный <iframe>, прочие форматы
// предпросмотра не имеют и открываются в новой вкладке вызывающим кодом.

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const FRAME_EXT = ['pdf', 'txt', 'md', 'csv'];

export type PreviewKind = 'image' | 'frame';

/** Страница-просмотрщик (docx/xlsx/презентации) — запасной путь и Ctrl+клик. */
export function fileViewUrl(att: MsgAttachment): string {
  return `/messenger/files/${att.id}/view`;
}

/**
 * Способ показа вложения или null — формат без предпросмотра.
 * Расширение берём из имени файла: url вида /api/messenger/files/12 его не несёт.
 */
export function previewKind(att: MsgAttachment): PreviewKind | null {
  if (att.is_image) return 'image';
  const clean = (att.name || att.url || '').split('?')[0];
  const ext = (clean.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (FRAME_EXT.includes(ext)) return 'frame';
  return null;
}

/** Клик по вложению открыл бы модалку? (иначе — обычный переход по ссылке) */
export function shouldPreview(e: React.MouseEvent, att: MsgAttachment): boolean {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
  return previewKind(att) !== null;
}

/** Модалка предпросмотра: iframe/картинка + скачивание и открытие в новой вкладке. */
export function FilePreviewModal({
  att,
  onClose,
}: {
  att: MsgAttachment;
  onClose: () => void;
}) {
  const kind = previewKind(att);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!kind) return null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 flex flex-col items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <a
          href={fileViewUrl(att)}
          target="_blank"
          rel="noopener"
          className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition"
          title="Открыть в новой вкладке"
        >
          <ExternalLink size={18} />
        </a>
        <a
          href={att.download_url}
          className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition"
          title="Скачать"
        >
          <Download size={18} />
        </a>
        <button
          onClick={onClose}
          className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20 transition"
          title="Закрыть"
        >
          <X size={18} />
        </button>
      </div>

      {kind === 'image' ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={att.url}
          alt={att.name}
          className="max-w-[92vw] max-h-[80vh] object-contain rounded-xl"
        />
      ) : (
        <iframe
          src={att.url}
          title={att.name}
          className="w-[min(92vw,900px)] h-[80vh] rounded-xl bg-white border-0"
        />
      )}

      <div className="mt-3 text-xs text-white/70 font-medium max-w-[92vw] truncate">{att.name}</div>
    </div>
  );
}
