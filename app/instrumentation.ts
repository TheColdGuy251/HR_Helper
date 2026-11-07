// Хук старта сервера Next.js.
//
// Прогревает LLM сразу при запуске: модель и CUDA-контекст llama.cpp обязаны
// появиться в процессе раньше onnxruntime - при
// обратном порядке первая генерация роняет процесс "ggml-cuda.cu:106: CUDA
// error" (см. warmupLlm в lib/ml/llm.ts). Эмбеддер дополнительно ждёт этот же
// прогрев, так что порядок гарантирован даже до завершения register().
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { warmupLlm } = await import('@/lib/ml/llm');
  // Не блокируем старт сервера: страницы и API доступны сразу, модель греется в фоне.
  void warmupLlm();

  // Восстановление после рестарта (тоже в фоне, ошибки не мешают старту):
  //  - сообщения ассистента, чья генерация оборвалась вместе с процессом,
  //    закрываются пометкой - иначе у пользователя вечное "печатает...";
  //  - незавершённый добор полей генерации документов поднимается из БД.
  void import('@/lib/chat')
    .then(({ recoverInterruptedStreams }) => recoverInterruptedStreams())
    .catch(() => undefined);
  void import('@/lib/docs/docgen')
    .then(({ loadDocgenState }) => loadDocgenState())
    .catch(() => undefined);
}
