"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react"; // Иконки для сворачивания
import { NodeType } from "@/app/types";

// Для примера мы создаем структуру каталогов. 
// Позже вы с Игорем сможете добавить сюда сколько угодно узлов.
interface CatalogGroup {
  title: string;
  type: NodeType;
  icon: string;
  nodes: { id: string; label: string; icon: string }[];
}

const CATALOG: CatalogGroup[] = [
  {
    title: "Триггеры (Входы)",
    type: "input",
    icon: "⚡",
    nodes: [
      { id: "input-text", label: "Текстовый ввод", icon: "📝" },
      { id: "input-webhook", label: "Webhook (API)", icon: "🔗" },
    ],
  },
  {
    title: "Условия и логика",
    type: "condition",
    icon: "🔀",
    nodes: [
      { id: "condition-text", label: "Проверка текста", icon: "🔍" },
      { id: "condition-math", label: "Математика", icon: "🧮" },
    ],
  },
  {
    title: "ИИ-узлы",
    type: "ai",
    icon: "🤖",
    nodes: [
      { id: "ai-gpt", label: "Запрос к LLM", icon: "🧠" },
    ],
  },
  {
    title: "Действия",
    type: "action",
    icon: "⚙️",
    nodes: [
      { id: "action-email", label: "Отправить Email", icon: "📧" },
      { id: "action-sms", label: "Отправить SMS", icon: "📱" },
    ],
  },
  {
    title: "Результаты",
    type: "output",
    icon: "✅",
    nodes: [
      { id: "output-screen", label: "Вывод на экран", icon: "🖥️" },
      { id: "output-file", label: "Сохранить в файл", icon: "💾" },
    ],
  },
];

export default function Sidebar() {
  // Храним состояние: какие категории открыты
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    input: true, // Триггеры открыты по умолчанию
    condition: true,
  });

  const toggleGroup = (type: string) => {
    setOpenGroups((prev) => ({ ...prev, [type]: !prev[type] }));
  };

  // Обработчик перетаскивания (передает базовый тип для React Flow)
  const onDragStart = (event: React.DragEvent, baseType: NodeType, label: string) => {
    event.dataTransfer.setData("application/reactflow", baseType);
    event.dataTransfer.setData("application/reactflow-label", label); 
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <aside className="w-64 bg-[#f8f9fa] border-r border-gray-200 h-full flex flex-col z-10 shadow-sm">
      <div className="p-4 border-b border-gray-200 bg-white">
        <h2 className="text-base font-bold text-gray-800">Элементы</h2>
        <p className="text-xs text-gray-500 mt-1">Перетащите на холст</p>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {CATALOG.map((group) => (
          <div key={group.type} className="mb-1">
            {/* Заголовок группы (кнопка сворачивания) */}
            <button
              onClick={() => toggleGroup(group.type)}
              className="w-full flex items-center gap-2 px-4 py-2 hover:bg-gray-100 transition text-left"
            >
              {openGroups[group.type] ? (
                <ChevronDown size={14} className="text-gray-400" />
              ) : (
                <ChevronRight size={14} className="text-gray-400" />
              )}
              <span className="text-sm font-semibold text-gray-700">{group.title}</span>
            </button>

            {/* Список узлов внутри группы */}
            {openGroups[group.type] && (
              <div className="flex flex-wrap gap-2 px-4 pb-3 pt-1">
                {group.nodes.map((node) => (
                  <div
                    key={node.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, group.type, node.label)}
                    title={node.label}
                    className="flex flex-col items-center justify-center w-[68px] h-[68px] bg-white border border-gray-200 rounded-xl cursor-grab hover:border-blue-400 hover:shadow-md transition select-none"
                  >
                    <span className="text-2xl mb-1">{node.icon}</span>
                    <span className="text-[10px] text-center font-medium text-gray-600 leading-tight px-1">
                      {node.label}
                    </span>
                  </div>
                ))}
                
                {/* Если группа пустая (заглушка для будущего) */}
                {group.nodes.length === 0 && (
                   <div className="text-xs text-gray-400 italic py-2 w-full text-center border border-dashed rounded-lg">
                     Пока пусто
                   </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}