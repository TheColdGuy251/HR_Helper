import { NextResponse } from 'next/server';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { requireAdmin } from '@/lib/auth';

// Диагностика локальной LLM: показывает, видит ли сервер файл модели, какие
// настройки применились и почему инициализация не удалась. Нужен потому, что
// сам движок при ошибке молча переходит на ответ-заглушку, и по чату не понять,
// в чём дело: нет файла, не собрался нативный модуль или не хватило видеопамяти.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const modelPath =
    process.env.LLM_MODEL_PATH ||
    path.resolve(process.cwd(), '..', 'backend', 'models', 'T-lite-it-2.1-Q4_K_M.gguf');

  const info: Record<string, unknown> = {
    cwd: process.cwd(),
    model_path: modelPath,
    model_exists: existsSync(modelPath),
    env: {
      LLM_ENABLED: process.env.LLM_ENABLED ?? null,
      LLM_GPU_BACKEND: process.env.LLM_GPU_BACKEND ?? null,
      LLM_N_GPU_LAYERS: process.env.LLM_N_GPU_LAYERS ?? null,
      LLM_MAX_CONCURRENT: process.env.LLM_MAX_CONCURRENT ?? null,
      MODELS_DIR: process.env.MODELS_DIR ?? null,
    },
  };

  // Сведения о видеокарте берём без загрузки весов: собственная копия модели
  // здесь заняла бы ещё несколько гигабайт VRAM и приводила к CUDA OOM в чате.
  try {
    const { getLlama } = await import('node-llama-cpp');
    const backend = process.env.LLM_GPU_BACKEND;
    const llama = await getLlama(
      backend ? { gpu: backend === 'false' ? false : (backend as 'cuda' | 'vulkan') } : {}
    );
    info.llama_loaded = true;
    info.gpu = llama.gpu || 'cpu';
    const state = await llama.getVramState();
    info.vram = {
      total_mb: Math.round(state.total / 1024 / 1024),
      used_mb: Math.round(state.used / 1024 / 1024),
      free_mb: Math.round(state.free / 1024 / 1024),
    };
  } catch (e) {
    info.llama_error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  // Состояние общего движка приложения: он держит единственную копию модели.
  try {
    const { isLlmAvailable, queueStatus } = await import('@/lib/ml/llm');
    info.is_available = await isLlmAvailable();
    info.queue = await queueStatus();
  } catch (e) {
    info.engine_error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  return NextResponse.json(info);
}
