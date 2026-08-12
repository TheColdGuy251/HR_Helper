// Хук старта сервера Next.js.
//
// Прогревает LLM сразу при запуске: модель и CUDA-контекст llama.cpp обязаны
// появиться в процессе РАНЬШЕ onnxruntime (эмбеддера Transformers.js) — при
// обратном порядке первая генерация роняет процесс «ggml-cuda.cu:106: CUDA
// error» (см. warmupLlm в lib/ml/llm.ts). Эмбеддер дополнительно ждёт этот же
// прогрев, так что порядок гарантирован даже до завершения register().
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { warmupLlm } = await import('@/lib/ml/llm');
  // Не блокируем старт сервера: страницы и API доступны сразу, модель греется в фоне.
  void warmupLlm();
}
