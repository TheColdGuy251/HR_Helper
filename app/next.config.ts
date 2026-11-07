import type { NextConfig } from "next";

// Правил rewrite нет: все пути обслуживает само приложение, и несуществующий
// путь честно отвечает 404.

const nextConfig: NextConfig = {
  // Пакеты с нативными бинарниками и большими ONNX-рантаймами нельзя бандлить:
  // node-llama-cpp грузит .node/.dll, Transformers.js - onnxruntime-node. После
  // сборки пути внутри бандла ломаются, и модель молча не загружается (чат
  // отвечал заглушкой "LLM не загружена"). Здесь они подключаются обычным require.
  serverExternalPackages: [
    'node-llama-cpp',
    '@huggingface/transformers',
    'onnxruntime-node',
    'sharp',
    // 7-Zip в WebAssembly (дедуп инструкций ОТ): грузит 7zz.wasm с диска
    // рядом с собой - при бандлинге относительный путь до .wasm ломается.
    '7z-wasm',
  ],
};

export default nextConfig;
