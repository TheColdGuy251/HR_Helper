// У пакета snowball-stemmers нет собственных типов, а @types для него не издан.
// Описываем ровно то, что используем: фабрику стеммера для морфологической
// нормализации русского в BM25 (см. lib/ml/bm25.ts).
declare module 'snowball-stemmers' {
  export interface SnowballStemmer {
    stem(word: string): string;
  }
  export function newStemmer(language: string): SnowballStemmer;
}
