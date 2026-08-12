'use client';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

// Модалка «все источники» (порт openSourcesModal из chat.js).
// Блок источников в ответе схлопнут до трёх карточек, кнопка `.md-sources-more`
// (её рисует lib/msgfmt.ts) открывает полный список.

function SourcesModal({ html, onClose }: { html: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[95] bg-black/30 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-gray-100 rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[80vh] overflow-hidden">
        <div className="p-4 border-b border-gray-50 flex items-center justify-between">
          <span className="font-bold text-sm text-[#0f1c3f]">Источники</span>
          <button onClick={onClose} className="p-1 text-gray-300 hover:text-gray-500 transition">
            <X size={16} />
          </button>
        </div>
        <div
          className="flex-1 overflow-y-auto p-4 msg-md text-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

/**
 * Делегированный обработчик для контейнера с отрендеренными сообщениями.
 * Возвращает `onSourcesClick` (вешать на ленту) и готовый узел модалки.
 */
export function useSourcesModal() {
  const [html, setHtml] = useState<string | null>(null);

  const onSourcesClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest?.('.md-sources-more');
    if (!btn) return;
    e.preventDefault();
    const docs = btn.closest('.md-docs');
    if (docs) {
      const clone = docs.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.md-sources-more').forEach((b) => b.remove());
      setHtml(`<div class="md-docs md-docs-modal">${clone.innerHTML}</div>`);
      return;
    }
    // Легаси-фолбэк: блок «Источники» из текста модели (ul/li).
    const ul = btn.parentElement?.querySelector('ul');
    if (ul) setHtml(`<ul class="md-sources-fulllist">${ul.innerHTML}</ul>`);
  };

  return {
    onSourcesClick,
    sourcesModal: html ? <SourcesModal html={html} onClose={() => setHtml(null)} /> : null,
  };
}
