// app/components/editor/settings-panel.tsx
"use client";

import React from "react";
import { useGraphStore } from "@/app/store/useGraphStore";
import { 
  InputNodeData, 
  ConditionNodeData, 
  OutputNodeData 
} from "@/app/types";

export default function SettingsPanel() {
  const { nodes, selectedNodeId, updateNodeData } = useGraphStore();
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  if (!selectedNode) {
    return (
      <aside className="w-72 bg-white border-l border-gray-200 p-4 h-full shadow-sm">
        <p className="text-sm text-gray-400 text-center mt-10">Выберите узел на холсте</p>
      </aside>
    );
  }

  // Базовое поле (Название) есть у всех
  const handleLabelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateNodeData(selectedNode.id, { label: e.target.value });
  };

  return (
    <aside className="w-72 bg-white border-l border-gray-200 p-4 h-full shadow-sm overflow-y-auto">
      <h2 className="text-lg font-bold text-gray-800 mb-4">Настройки узла</h2>
      
      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-500 mb-1">Название (Label)</label>
        <input
          type="text"
          value={selectedNode.data.label || ""}
          onChange={handleLabelChange}
          className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
        />
      </div>

      {/* --- Безопасная проверка типов --- */}
      
      {selectedNode.type === "input" && (
        <InputSettings 
          data={selectedNode.data as InputNodeData} 
          updateData={(newData) => updateNodeData(selectedNode.id, newData)} 
        />
      )}

      {selectedNode.type === "condition" && (
        <ConditionSettings 
          data={selectedNode.data as ConditionNodeData} 
          updateData={(newData) => updateNodeData(selectedNode.id, newData)} 
        />
      )}

      {selectedNode.type === "output" && (
        <OutputSettings 
          data={selectedNode.data as OutputNodeData} 
          updateData={(newData) => updateNodeData(selectedNode.id, newData)} 
        />
      )}
      
      <div className="mt-8 text-xs text-gray-400">ID: {selectedNode.id}</div>
    </aside>
  );
}

// --- Вынесенные компоненты для каждого типа (чтобы не загромождать основной) ---

function InputSettings({ data, updateData }: { data: InputNodeData, updateData: (d: any) => void }) {
  return (
    <div className="mb-4">
      <label className="block text-xs font-semibold text-gray-500 mb-1">Текст входа</label>
      <textarea
        value={data.text || ""}
        onChange={(e) => updateData({ text: e.target.value })}
        className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
        rows={3}
        placeholder="Например: красный цвет"
      />
    </div>
  );
}

function ConditionSettings({ data, updateData }: { data: ConditionNodeData, updateData: (d: any) => void }) {
  return (
    <div className="mb-4">
      <label className="block text-xs font-semibold text-gray-500 mb-1">Условие</label>
      <input
        type="text"
        value={data.compareValue || ""}
        onChange={(e) => updateData({ compareValue: e.target.value })}
        className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
        placeholder="С чем сравниваем?"
      />
    </div>
  );
}

function OutputSettings({ data, updateData }: { data: OutputNodeData, updateData: (d: any) => void }) {
  return (
    <div className="mb-4">
      <label className="block text-xs font-semibold text-gray-500 mb-1">Результат</label>
      <input
        type="text"
        value={data.result || ""}
        onChange={(e) => updateData({ result: e.target.value })}
        className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
        placeholder="Что вывести?"
      />
    </div>
  );
}