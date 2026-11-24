/** string.Equals(a, b, OrdinalIgnoreCase) — not EqualFold (no Turkish I, no ß, etc.). */

export function equalsOrdinalIgnoreCase(a: string, b: string): boolean {
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const x = a.codePointAt(ai)!;
    const y = b.codePointAt(bi)!;
    const xn = x > 0xffff ? 2 : 1;
    const yn = y > 0xffff ? 2 : 1;
    const xBad = x === 0xfffd && xn === 1 && (a.charCodeAt(ai) & 0xc0) === 0x80;
    const yBad = y === 0xfffd && yn === 1 && (b.charCodeAt(bi) & 0xc0) === 0x80;
    if (xBad || yBad) {
      if (!xBad || !yBad || a.charCodeAt(ai) !== b.charCodeAt(bi)) {
        return false;
      }
    } else if (ordinalUpper(x) !== ordinalUpper(y)) {
      return false;
    }
    ai += xn;
    bi += yn;
  }
  return ai >= a.length && bi >= b.length;
}

function ordinalUpper(code: number): number {
  if (code === 0x0131 || code === 0x017f) {
    return code;
  }
  if (code >= 0x61 && code <= 0x7a) {
    return code - 32;
  }
  if (code < 0x80) {
    return code;
  }
  return String.fromCodePoint(code).toUpperCase().codePointAt(0)!;
}