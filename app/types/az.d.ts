// У пакета az (Az.js — морфология русского на словарях OpenCorpora) нет
// собственных типов. Описываем то, что используем в lib/ml/bm25.ts:
// разбор словоформы и приведение к начальной форме.
declare module 'az' {
  export interface AzParse {
    word: string;
    normalize(keepForms?: boolean): AzParse;
    toString(): string;
  }

  export interface AzMorph {
    (word: string, config?: Record<string, unknown>): AzParse[];
    init(dictsPath: string, callback: (err?: Error) => void): void;
  }

  export const Morph: AzMorph;
  const Az: { Morph: AzMorph };
  export default Az;
}
