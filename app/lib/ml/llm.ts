import 'server-only';
import path from 'node:path';
import { existsSync } from 'node:fs';

// Локальная LLM (GGUF) через node-llama-cpp. Порт services/llm/client.py
// и services/assistant_queue.py.
//
// Важное отличие от Python: llama-cpp-python не потокобезопасен, поэтому там
// все генерации сериализованы одним локом. node-llama-cpp умеет несколько
// независимых последовательностей в одном контексте и считает их параллельно
// в общем батче — поэтому здесь работает пул на LLM_MAX_CONCURRENT слотов,
// а не «один запрос за раз».
//
// Сверх лимита запросы ждут в очереди и получают свою позицию (её показывает
// интерфейс чата). Очередь ограничена по длине и по числу запросов от одного
// пользователя — как в assistant_queue.py.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const MODEL_PATH = () =>
  process.env.LLM_MODEL_PATH ||
  path.resolve(process.cwd(), '..', 'backend', 'models', 'T-lite-it-2.1-Q4_K_M.gguf');

const N_CTX = Number(process.env.LLM_N_CTX || 16384);
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 2048);
const TEMPERATURE = Number(process.env.LLM_TEMPERATURE || 0.3);
const TOP_P = Number(process.env.LLM_TOP_P || 0.9);
const ENABLED = String(process.env.LLM_ENABLED ?? 'true').toLowerCase() !== 'false';

/** Сколько генераций считается одновременно. Каждая занимает свой слот контекста. */
export const MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.LLM_MAX_CONCURRENT || process.env.ASSISTANT_MAX_CONCURRENT || 2)
);
/** Предел длины очереди ожидания: сверх него запросы отклоняются (backpressure). */
const MAX_WAITING = Math.max(1, Number(process.env.ASSISTANT_QUEUE_MAXSIZE || 50));
/** Сколько запросов одного пользователя могут ждать одновременно (анти-флуд). */
const MAX_PER_USER = Math.max(1, Number(process.env.ASSISTANT_MAX_PER_USER || 3));

// Слои модели на видеокарте. В node-llama-cpp значение 'max' означает «все»;
// число -1 из конфигурации Python здесь не работает и оставит модель на CPU.
function gpuLayersSetting(): 'max' | 'auto' | number {
  const raw = process.env.LLM_N_GPU_LAYERS ?? 'max';
  if (raw === 'max' || raw === 'auto') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'max';
  return n < 0 ? 'max' : n;
}

export class QueueRejected extends Error {
  reason: 'queue_full' | 'per_user_limit';
  constructor(message: string, reason: 'queue_full' | 'per_user_limit') {
    super(message);
    this.reason = reason;
  }
}

type Sequence = { dispose: () => void };
type Session = {
  prompt: (
    text: string,
    opts: {
      onTextChunk?: (t: string) => void;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    }
  ) => Promise<string>;
};

interface Slot {
  sequence: Sequence;
  busy: boolean;
}

interface Engine {
  makeSession: (slot: Slot, system: string, history: ChatMessage[]) => Session;
  slots: Slot[];
}

const g = globalThis as unknown as {
  __hrLlm?: Promise<Engine | null>;
  __hrLlmWaiters?: { userId: number | null; resolve: (slot: Slot) => void }[];
  __hrLlmWarmup?: Promise<void>;
};

function waiters() {
  if (!g.__hrLlmWaiters) g.__hrLlmWaiters = [];
  return g.__hrLlmWaiters;
}

async function getEngine(): Promise<Engine | null> {
  if (!g.__hrLlm) {
    g.__hrLlm = (async () => {
      if (!ENABLED) return null;
      const modelPath = MODEL_PATH();
      if (!existsSync(modelPath)) return null;

      try {
        const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
        const backend = process.env.LLM_GPU_BACKEND;
        const llama = await getLlama(
          backend ? { gpu: backend === 'false' ? false : (backend as 'cuda' | 'vulkan') } : {}
        );
        const model = await llama.loadModel({ modelPath, gpuLayers: gpuLayersSetting() });

        // Один контекст с несколькими последовательностями: они считаются
        // параллельно, но делят общий объём KV-кэша.
        //
        // Размер задаём как верхнюю границу, а не жёстко: при полной выгрузке
        // слоёв на видеокарту KV-кэш на 16k × несколько слотов уже не помещается
        // в 12 ГБ вместе с весами, и загрузка падает с «CUDA out of memory».
        // node-llama-cpp сам уменьшит окно до того, что реально влезает.
        const context = await model.createContext({
          contextSize: { max: N_CTX },
          sequences: MAX_CONCURRENT,
        });

        const slots: Slot[] = [];
        for (let i = 0; i < MAX_CONCURRENT; i++) {
          slots.push({ sequence: context.getSequence() as unknown as Sequence, busy: false });
        }

        return {
          slots,
          makeSession: (slot, system, history) => {
            const session = new LlamaChatSession({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              contextSequence: slot.sequence as any,
              systemPrompt: system,
            });
            if (history.length) {
              session.setChatHistory([
                { type: 'system', text: system },
                ...history.map((m) =>
                  m.role === 'user'
                    ? { type: 'user' as const, text: m.content }
                    : { type: 'model' as const, response: [m.content] }
                ),
              ]);
            }
            return session as unknown as Session;
          },
        };
      } catch {
        return null; // не собралось/модель не открылась — уходим в заглушку
      }
    })();
  }
  return g.__hrLlm;
}

/**
 * Прогрев LLM: загрузка движка, контекста и одна генерация в 1 токен.
 *
 * ПОРЯДОК ЗАГРУЗКИ КРИТИЧЕН. Если onnxruntime (эмбеддер Transformers.js)
 * оказывается в процессе раньше llama.cpp, первая же CUDA-генерация роняет
 * весь процесс: «ggml-cuda.cu:106: CUDA error» — конфликт рантаймов в одном
 * процессе (воспроизведён на драйвере NVIDIA 591.86 / CUDA 13.1; обратный
 * порядок стабилен, включая генерации ПОСЛЕ загрузки onnxruntime).
 *
 * Прогрев запускает instrumentation.ts на старте сервера, а эмбеддер
 * (lib/ml/embeddings.ts) дополнительно ждёт его перед своей инициализацией —
 * это закрывает и dev-режим, и случаи, когда instrumentation не успел.
 * Бонус: первый ответ ассистента больше не платит ~10 секунд за загрузку.
 */
export function warmupLlm(): Promise<void> {
  if (!g.__hrLlmWarmup) {
    g.__hrLlmWarmup = (async () => {
      try {
        const engine = await getEngine();
        if (!engine) return; // LLM выключена или модель не нашлась — нечего греть
        const slot = engine.slots.find((s) => !s.busy);
        if (!slot) return;
        slot.busy = true;
        try {
          const session = engine.makeSession(slot, 'Ты — ассистент.', []);
          await session.prompt('ок', { maxTokens: 1, temperature: 0 });
        } finally {
          slot.busy = false;
        }
      } catch {
        /* прогрев не удался — чат ответит заглушкой, эмбеддер работает дальше */
      }
    })();
  }
  return g.__hrLlmWarmup;
}

/** Текущее состояние очереди — отдаётся эндпоинтом статуса. */
export async function queueStatus() {
  const engine = await getEngine();
  const running = engine ? engine.slots.filter((s) => s.busy).length : 0;
  return {
    running,
    waiting: waiters().length,
    max_concurrent: MAX_CONCURRENT,
    max_waiting: MAX_WAITING,
    max_per_user: MAX_PER_USER,
    available: Boolean(engine),
  };
}

/**
 * Занимает свободный слот. Если свободных нет — встаёт в очередь и сообщает
 * свою позицию через onPosition, пока ждёт.
 */
async function acquireSlot(
  engine: Engine,
  userId: number | null,
  onPosition?: (position: number, total: number) => void
): Promise<Slot> {
  const free = engine.slots.find((s) => !s.busy);
  if (free) {
    free.busy = true;
    return free;
  }

  const queue = waiters();
  if (queue.length >= MAX_WAITING) {
    throw new QueueRejected(
      'Ассистент перегружен, попробуйте через минуту.',
      'queue_full'
    );
  }
  if (userId != null && queue.filter((w) => w.userId === userId).length >= MAX_PER_USER) {
    throw new QueueRejected(
      'Слишком много одновременных запросов. Дождитесь ответа на предыдущий.',
      'per_user_limit'
    );
  }

  return new Promise<Slot>((resolve) => {
    const waiter = { userId, resolve };
    queue.push(waiter);
    // Сообщаем позицию сразу и на каждом сдвиге очереди (см. releaseSlot).
    onPosition?.(queue.indexOf(waiter) + 1, queue.length);
  });
}

function releaseSlot(slot: Slot) {
  const queue = waiters();
  const next = queue.shift();
  if (next) {
    next.resolve(slot); // слот сразу уходит следующему, busy не снимаем
  } else {
    slot.busy = false;
  }
}

function mockAnswer(user: string): string {
  return (
    'Локальная модель сейчас недоступна, поэтому отвечаю без неё.\n\n' +
    `Ваш запрос: «${user.slice(0, 200)}».\n\n` +
    'Проверьте, что файл модели лежит в backend/models и не выключён LLM_ENABLED.'
  );
}

export function isLlmAvailable(): Promise<boolean> {
  return getEngine().then(Boolean);
}

/**
 * Потоковая генерация: асинхронный итератор кусков текста, готовый к отдаче в SSE.
 * Пока запрос ждёт слот, вызывается onPosition — интерфейс показывает очередь.
 */
export async function* chatStream({
  system,
  user,
  history = [],
  temperature,
  maxTokens,
  signal,
  userId = null,
  onPosition,
}: {
  system: string;
  user: string;
  history?: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  userId?: number | null;
  onPosition?: (position: number, total: number) => void;
}): AsyncGenerator<string> {
  const engine = await getEngine();
  if (!engine) {
    yield mockAnswer(user);
    return;
  }

  const slot = await acquireSlot(engine, userId, onPosition);

  // Куски отдаются наружу через буфер, чтобы потребитель получал текст сразу,
  // не дожидаясь конца генерации.
  const queue: string[] = [];
  let done = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;

  const push = (chunk: string) => {
    queue.push(chunk);
    wake?.();
    wake = null;
  };

  const session = engine.makeSession(slot, system, history);
  const run = session
    .prompt(user, {
      onTextChunk: push,
      temperature: temperature ?? TEMPERATURE,
      topP: TOP_P,
      maxTokens: maxTokens ?? MAX_TOKENS,
      signal,
    })
    .catch((e: Error) => {
      failure = e;
    })
    .finally(() => {
      done = true;
      releaseSlot(slot);
      wake?.();
      wake = null;
    });

  try {
    for (;;) {
      while (queue.length) yield queue.shift() as string;
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    while (queue.length) yield queue.shift() as string;
    if (failure) yield `\n[Ошибка генерации: ${(failure as Error).message}]`;
  } finally {
    // Потребитель мог прерваться (закрыл вкладку) — дожидаемся завершения
    // генерации, иначе слот останется занятым навсегда.
    await run.catch(() => undefined);
  }
}

/** Разовая генерация без стрима: заголовки диалогов, извлечение полей и т.п. */
export async function generateText({
  system,
  user,
  history = [],
  temperature = 0,
  maxTokens = 200,
  userId = null,
}: {
  system: string;
  user: string;
  history?: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  userId?: number | null;
}): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of chatStream({
    system,
    user,
    history,
    temperature,
    maxTokens,
    userId,
  })) {
    parts.push(chunk);
  }
  return parts.join('').trim();
}
