import type { NextConfig } from "next";

// Перенос завершён: FastAPI больше не участвует в работе приложения, поэтому
// правил rewrite на localhost:8000 здесь нет. Раньше они страховали ещё не
// перенесённые пути, но давали и побочный эффект — при выключенном Python
// любой несуществующий путь отвечал 500 вместо 404.
//
// Если понадобится сверить поведение со старым бэкендом, поднимайте его
// отдельно (.\start.ps1 -WithPython) и обращайтесь к нему напрямую на :8000.

const nextConfig: NextConfig = {
  // Пакеты с нативными бинарниками и большими ONNX-рантаймами нельзя бандлить:
  // node-llama-cpp грузит .node/.dll, Transformers.js — onnxruntime-node. После
  // сборки пути внутри бандла ломаются, и модель молча не загружается (чат
  // отвечал заглушкой «LLM не загружена»). Здесь они подключаются обычным require.
  serverExternalPackages: [
    'node-llama-cpp',
    '@huggingface/transformers',
    'onnxruntime-node',
    'sharp',
    // 7-Zip в WebAssembly (дедуп инструкций ОТ): грузит 7zz.wasm с диска
    // рядом с собой — при бандлинге относительный путь до .wasm ломается.
    '7z-wasm',
  ],
};

export default nextConfig;
