// Замер скорости генерации локальной LLM в токенах в секунду.
// Помогает понять, укладывается ли перенесённый инференс в приемлемое время
// ответа и какой бэкенд выгоднее (CUDA/Vulkan/CPU).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const modelPath =
  process.env.LLM_MODEL_PATH ||
  path.resolve(HERE, '..', '..', 'backend', 'models', 'T-lite-it-2.1-Q4_K_M.gguf');

const backend = process.env.LLM_GPU_BACKEND;
const llama = await getLlama(backend ? { gpu: backend === 'false' ? false : backend } : {});
const model = await llama.loadModel({
  modelPath,
  gpuLayers: Number(process.env.LLM_N_GPU_LAYERS ?? -1),
});
const context = await model.createContext({ contextSize: 4096 });
const session = new LlamaChatSession({
  contextSequence: context.getSequence(),
  systemPrompt: 'Ты — HR-ассистент. Отвечай по-русски.',
});

console.log('Бэкенд       :', llama.gpu || 'cpu');
console.log('Слоёв на GPU :', model.gpuLayers ?? '—');

const prompt = 'Перечисли пять оснований для расторжения трудового договора, кратко.';

// Первый прогон прогревает кэши, поэтому меряем второй.
for (const label of ['прогрев', 'замер']) {
  let text = '';
  const t0 = Date.now();
  await session.prompt(prompt, {
    temperature: 0.3,
    maxTokens: 200,
    onTextChunk: (c) => {
      text += c;
    },
  });
  const dt = (Date.now() - t0) / 1000;
  const tokens = model.tokenize(text).length;
  console.log(
    `${label.padEnd(8)} символов=${text.length} токенов=${tokens} ` +
      `время=${dt.toFixed(1)}с скорость=${(tokens / dt).toFixed(1)} ток/с`
  );
}
await context.dispose();
