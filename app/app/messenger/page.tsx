'use client';
import { useEffect, useState } from 'react';
import { MessagesSquare, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Conversations } from '@/components/messenger/conversations';
import { Thread } from '@/components/messenger/thread';
import type { ActiveConv } from '@/components/messenger/types';

// Мессенджер: слева список бесед, справа тред.
// На узких экранах панели показываются по очереди (список ↔ диалог).
// Список можно свернуть (порт mpSidebarToggle, messenger_page.js:49-51);
// состояние запоминаем, как в чате с ассистентом (chat.js:2394-2401).

const SIDEBAR_KEY = 'mpSidebarCollapsed';

function EmptyPanel() {
  return (
    <div className="flex-1 bg-white border border-gray-100 rounded-2xl shadow-sm flex flex-col items-center justify-center gap-3 text-center px-6">
      <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center text-[#2563eb]">
        <MessagesSquare size={26} />
      </div>
      <p className="text-sm font-bold text-[#0f1c3f]">Выберите беседу</p>
      <p className="text-xs text-gray-400 max-w-xs">
        Общий чат, личные заметки или диалог с коллегой — в списке слева. Здесь же можно спросить
        ИИ-ассистента прямо в переписке.
      </p>
    </div>
  );
}

export default function MessengerPage() {
  const [active, setActive] = useState<ActiveConv | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [popup, setPopup] = useState(false);

  // ?popup=1 — страница открыта как отдельное окно (вынос миничата): чат на всё
  // окно, список свёрнут. Иначе поднимаем запомненное состояние сайдбара.
  useEffect(() => {
    let isPopup = false;
    try {
      isPopup = new URLSearchParams(window.location.search).has('popup');
    } catch {
      /* нестандартный URL */
    }
    setPopup(isPopup);
    if (isPopup) {
      setCollapsed(true);
      return;
    }
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === '1');
    } catch {
      /* приватный режим */
    }
  }, []);

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (popup) return; // размеры отдельного окна не запоминаем
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
    } catch {
      /* приватный режим */
    }
  };

  return (
    <div
      className={`relative flex-1 max-w-7xl w-full mx-auto px-4 flex flex-col md:flex-row gap-6 min-h-0 ${
        popup ? 'py-2 h-[100dvh]' : 'py-6 h-[calc(100vh-100px)]'
      }`}
    >
      <div
        className={`w-full flex-1 md:flex-none min-h-0 flex-col transition-[width,opacity] duration-200 ${
          active ? 'hidden md:flex' : 'flex'
        } ${
          collapsed
            ? 'md:w-0 md:min-w-0 md:opacity-0 md:overflow-hidden md:pointer-events-none'
            : 'md:w-80'
        }`}
      >
        <Conversations active={active} onSelect={setActive} />
      </div>

      {/* тумблер списка бесед — только на десктопе, едет вместе с краем панели */}
      <button
        onClick={toggleSidebar}
        title={collapsed ? 'Показать список бесед' : 'Свернуть список бесед'}
        aria-label="Список бесед"
        style={{ left: collapsed ? '0.25rem' : 'calc(21rem - 0.875rem)' }}
        className="hidden md:flex absolute top-1/2 -translate-y-1/2 z-20 w-7 h-14 items-center justify-center rounded-lg bg-white border border-gray-100 shadow-sm text-gray-400 hover:text-[#2563eb] transition-[left,color] duration-200"
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>

      <div className={`flex-1 min-w-0 min-h-0 flex-col ${active ? 'flex' : 'hidden md:flex'}`}>
        {active ? (
          <Thread key={active.key} conv={active} onBack={() => setActive(null)} />
        ) : (
          <EmptyPanel />
        )}
      </div>
    </div>
  );
}
