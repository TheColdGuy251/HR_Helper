import 'server-only';

/**
 * Приведение должности к именительному падежу — замена pymorphy3 из
 * services/documents/vacancy.py (_to_nominative).
 *
 * Az.js работает на тех же словарях OpenCorpora, что и pymorphy3, и даёт те же
 * граммемы (NOUN/ADJF/PRTF, падежи). Как и в Python, любая ошибка морфологии
 * означает «оставить строку как есть» — это не критичный шаг.
 */

interface AzTag {
  POS?: string;
  NMbr?: string;
}
interface AzParse {
  word: string;
  tag: AzTag;
  inflect(grammemes: string[]): AzParse | false;
}
type MorphFn = ((word: string) => AzParse[]) & {
  init: (path: string, cb: (err?: Error) => void) => void;
};

let morph: MorphFn | null = null;
let ready: Promise<void> | null = null;

async function initMorph(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      try {
        const path = await import('node:path');
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        const az = require('az') as { Morph: MorphFn };
        const dicts = path.join(path.dirname(require.resolve('az/package.json')), 'dicts');
        await new Promise<void>((resolve, reject) => {
          az.Morph.init(dicts, (err?: Error) => (err ? reject(err) : resolve()));
        });
        morph = az.Morph;
      } catch {
        morph = null; // словари не нашлись — работаем без морфологии
      }
    })();
  }
  return ready;
}

/**
 * «специалиста ректората» → «специалист ректората»: ведущие прилагательные и
 * первое существительное приводим к именительному, дополнение («ректората»)
 * остаётся в родительном — так и должно быть.
 */
export async function toNominative(pos: string): Promise<string> {
  await initMorph();
  if (!morph) return pos;
  try {
    const words = pos.split(/\s+/).filter((w) => w);
    const out: string[] = [];
    let headDone = false;
    for (const w of words) {
      if (headDone) {
        out.push(w);
        continue;
      }
      const p = morph(w)[0];
      const posTag = p?.tag?.POS;
      if (p && (posTag === 'NOUN' || posTag === 'ADJF' || posTag === 'PRTF')) {
        // Число фиксируем явно: Az выбирает ПЕРВУЮ подходящую форму, а pymorphy
        // сохраняет остальные граммемы исходной словоформы.
        const grammemes = p.tag.NMbr ? ['nomn', p.tag.NMbr] : ['nomn'];
        const nom = p.inflect(grammemes) || p.inflect(['nomn']);
        out.push(nom ? nom.word : w);
        if (posTag === 'NOUN') headDone = true;
      } else {
        out.push(w);
        headDone = true;
      }
    }
    return out.join(' ');
  } catch {
    return pos;
  }
}
