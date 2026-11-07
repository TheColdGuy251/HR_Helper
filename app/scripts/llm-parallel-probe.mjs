// Проверяет, что модель обслуживает несколько генераций одновременно.
//
// Запускает N запросов разом при лимите слотов = LLM_MAX_CONCURRENT и смотрит,
// сколько работали параллельно. Если бы генерации сериализовались,
// суммарное время было бы близко к сумме одиночных.
//
// Использование: node scripts/llm-parallel-probe.mjs [запросов] [слотов]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const modelPath =
  process.env.LLM_MODEL_PATH ||
  path.resolve(HERE, '..', '..', 'backend', 'models', 'T-lite-it-2.1-Q4_K_M.gguf');

const REQUESTS = Number(process.argv[2] || 4);
const SLOTS = Number(process.argv[3] || process.env.LLM_MAX_CONCURRENT || 2);

const backend = process.env.LLM_GPU_BACKEND;
const llama = await getLlama(backend ? { gpu: backend === 'false' ? false : backend } : {});
const model = await llama.loadModel({ modelPath, gpuLayers: process.env.LLM_N_GPU_LAYERS ?? 'max' });
const context = await model.createContext({ contextSize: 8192, sequences: SLOTS });

console.log(`Бэкенд: ${llama.gpu || 'cpu'} | слоёв на GPU: ${model.gpuLayers}`);
console.log(`Запросов: ${REQUESTS}, слотов: ${SLOTS}\n`);

const pool = [];
for (let i = 0; i < SLOTS; i++) pool.push({ seq: context.getSequence(), busy: false });

let peak = 0;
let active = 0;
const waiting = [];

function take() {
  const free = pool.find((s) => !s.busy);
  if (free) {
    free.busy = true;
    return Promise.resolve(free);
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function give(slot) {
  const next = waiting.shift();
  if (next) next(slot);
  else slot.busy = false;
}

const questions = Array.from({ length: REQUESTS }, (_, i) =>
  `Вопрос ${i + 1}: назови одно основание увольнения и поясни в одном предложении.`
);

const t0 = Date.now();
const results = await Promise.all(
  questions.map(async (q, i) => {
    const slot = await take();
    active++;
    peak = Math.max(peak, active);
    const started = Date.now();
    const session = new LlamaChatSession({
      contextSequence: slot.seq,
      systemPrompt: 'Ты — HR-ассистент. Отвечай кратко, по-русски.',
    });
    let text = '';
    try {
      await session.prompt(q, { temperature: 0.3, maxTokens: 60, onTextChunk: (c) => (text += c) });
    } finally {
      active--;
      give(slot);
    }
    return { i, ms: Date.now() - started, chars: text.length };
  })
);
const total = (Date.now() - t0) / 1000;

for (const r of results) {
  console.log(`  запрос ${r.i + 1}: ${(r.ms / 1000).toFixed(1)} с, ${r.chars} символов`);
}
const sum = results.reduce((a, r) => a + r.ms, 0) / 1000;
console.log(`\nПиковая параллельность: ${peak} (лимит ${SLOTS})`);
console.log(`Суммарное время генераций: ${sum.toFixed(1)} с`);
console.log(`Фактическое время: ${total.toFixed(1)} с`);
console.log(
  total < sum * 0.85
    ? 'Генерации шли параллельно.'
    : 'Параллельности не видно — похоже на последовательное выполнение.'
);
await context.dispose();
