import 'server-only';
import PizZip from 'pizzip';

/** Чтение ZIP-архива инструкций (Б7). */

// CP437 - кодировка имён файлов в ZIP, когда флаг UTF-8 не выставлен.
// Так имена из архивов, созданных проводником Windows, читаются как в самой
// Windows.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

export interface ZipEntry {
  /** Имя записи целиком, как в архиве (может содержать каталоги). */
  name: string;
  dir: boolean;
  read: () => Buffer;
}

/** Записи архива в порядке центрального каталога - как zf.infolist(). */
export function readZipEntries(data: Buffer): ZipEntry[] {
  const zip = new PizZip(data, { decodeFileName: decodeCp437 });
  return Object.keys(zip.files).map((name) => {
    const entry = zip.files[name];
    return {
      name,
      dir: Boolean(entry.dir),
      read: () => entry.asNodeBuffer() as Buffer,
    };
  });
}
