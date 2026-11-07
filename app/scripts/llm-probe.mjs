// Проверка локальной LLM: загружает GGUF-модель из backend/models
// и генерирует короткий ответ со стримингом.
//
// Использование: node scripts/llm-probe.mjs "вопрос"
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const modelPath =
  process.env.LLM_MODEL_PATH ||
  path.resolve(HERE, '..', '..', 'backend', 'models', 'T-lite-it-2.1-Q4_K_M.gguf');

if (!existsSync(modelPath)) {
  console.error('Файл модели не найден:', modelPath);
  process.exit(1);
}

const question = process.argv[2] || 'Ответь одним предложением: что такое трудовой договор?';

console.log('Загружаю модель:', path.basename(modelPath));
const t0 = Date.now();
// Бэкенд можно задать явно: у NVIDIA CUDA заметно быстрее Vulkan.
const gpu = process.env.LLM_GPU_BACKEND || undefined; // 'cuda' | 'vulkan' | 'false'
const llama = await getLlama(gpu ? { gpu: gpu === 'false' ? false : gpu } : {});
console.log('Бэкенд:', llama.gpu || 'cpu');
const model = await llama.loadModel({ modelPath, gpuLayers: Number(process.env.LLM_N_GPU_LAYERS || 0) });
const context = await model.createContext({ contextSize: 4096 });
const session = new LlamaChatSession({
  contextSequence: context.getSequence(),
  systemPrompt: 'Ты — HR-ассистент ТИУ. Отвечай кратко и по-русски.',
});
console.log(`Модель готова за ${((Date.now() - t0) / 1000).toFixed(1)} с\n`);

console.log('Вопрос:', question);
process.stdout.write('Ответ: ');
const t1 = Date.now();
let chunks = 0;
await session.prompt(question, {
  temperature: 0.3,
  maxTokens: 120,
  onTextChunk: (text) => {
    chunks++;
    process.stdout.write(text);
  },
});
const dt = (Date.now() - t1) / 1000;
console.log(`\n\nФрагментов: ${chunks}, время: ${dt.toFixed(1)} с, ~${(chunks / dt).toFixed(1)} фраг/с`);
await context.dispose();
