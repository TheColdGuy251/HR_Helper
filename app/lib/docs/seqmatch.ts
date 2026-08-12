import 'server-only';

/**
 * Порт difflib.SequenceMatcher из стандартной библиотеки Python для случая,
 * в котором его используют ot_dedup.py и pages.py::_build_diff_html:
 * isjunk=None и autojunk=False (сравнение идёт по СПИСКАМ СЛОВ/СТРОК,
 * а не по символам).
 *
 * Алгоритм воспроизведён дословно, потому что «процент совпадения» попадает
 * в отчёт отдела ОТ: другая метрика дала бы другие пары дубликатов. По той же
 * причине опкоды считаются здесь, а не «похожим» diff-алгоритмом из npm:
 * разбивка на блоки должна совпадать с Python до строки.
 */

/** Совпадающий блок get_matching_blocks(): [i в a, j в b, длина]. */
type Block = [number, number, number];

/**
 * get_matching_blocks(): максимальные совпадающие блоки, отсортированные и
 * склеенные, с замыкающим пустым блоком (la, lb, 0) — как в difflib.
 */
function matchingBlocks(a: string[], b: string[]): Block[] {
  // __chain_b: индексы каждого элемента b. Мусорных элементов нет (isjunk=None),
  // «популярные» не отбрасываются (autojunk=False) — поэтому b2j полный.
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i += 1) {
    const list = b2j.get(b[i]);
    if (list) list.push(i);
    else b2j.set(b[i], [i]);
  }

  const findLongestMatch = (alo: number, ahi: number, blo: number, bhi: number): Block => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map<number, number>();
      const js = b2j.get(a[i]);
      if (js) {
        for (const j of js) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    // Расширение блока по краям. Второй проход исходника (по «мусорным»
    // элементам) здесь не нужен: множество junk пустое.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return [besti, bestj, bestsize];
  };

  // Рекурсия развёрнута в очередь, как в оригинале.
  const found: Block[] = [];
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const block = findLongestMatch(alo, ahi, blo, bhi);
    const [i, j, k] = block;
    if (!k) continue;
    found.push(block);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  // matching_blocks.sort() — лексикографически по кортежу (i, j, k).
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

  // Склейка соседних блоков: на ratio не влияет, но для опкодов обязательна —
  // иначе между двумя «equal» появился бы пустой replace.
  const merged: Block[] = [];
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  for (const [i2, j2, k2] of found) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) merged.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) merged.push([i1, j1, k1]);
  merged.push([a.length, b.length, 0]); // страж: закрывает хвостовой diff
  return merged;
}

/** Доля совпадающих элементов: 2*M/T по блокам get_matching_blocks(). */
export function sequenceRatio(a: string[], b: string[]): number {
  let matches = 0;
  for (const [, , k] of matchingBlocks(a, b)) matches += k;
  const length = a.length + b.length;
  return length ? (2.0 * matches) / length : 1.0;
}

/** Опкод get_opcodes(): [тег, i1, i2, j1, j2] — как делать из a[i1:i2] b[j1:j2]. */
export type Opcode = ['equal' | 'replace' | 'delete' | 'insert', number, number, number, number];

/** get_opcodes(): описание преобразования a → b «дырками» между совпадениями. */
export function sequenceOpcodes(a: string[], b: string[]): Opcode[] {
  let i = 0;
  let j = 0;
  const answer: Opcode[] = [];
  for (const [ai, bj, size] of matchingBlocks(a, b)) {
    let tag: Opcode[0] | '' = '';
    if (i < ai && j < bj) tag = 'replace';
    else if (i < ai) tag = 'delete';
    else if (j < bj) tag = 'insert';
    if (tag) answer.push([tag, i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) answer.push(['equal', ai, i, bj, j]);
  }
  return answer;
}

// ── CRC-32 (zlib.crc32) ────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** zlib.crc32(bytes) — беззнаковое 32-битное. */
export function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
