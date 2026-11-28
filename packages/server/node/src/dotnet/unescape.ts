/** Uri.UnescapeDataString: escapes that form valid UTF-8 decode; others stay as written. */

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function unhex(c: number): number {
  if (c >= 0x30 && c <= 0x39) {
    return c - 0x30;
  }
  if (c >= 0x41 && c <= 0x46) {
    return c - 0x41 + 10;
  }
  return c - 0x61 + 10;
}

function utf8RuneSize(b0: number): number {
  if (b0 <= 0x7f) {
    return 1;
  }
  if ((b0 & 0xe0) === 0xc0) {
    return 2;
  }
  if ((b0 & 0xf0) === 0xe0) {
    return 3;
  }
  if ((b0 & 0xf8) === 0xf0) {
    return 4;
  }
  return 1;
}

function validUtf8Tail(raw: number[], size: number): boolean {
  for (let k = 1; k < size; k += 1) {
    if ((raw[k] & 0xc0) !== 0x80) {
      return false;
    }
  }
  return true;
}

export function unescapeDataString(s: string): string {
  if (!s.includes('%')) {
    return s;
  }
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) !== 0x25 || i + 2 >= s.length || !isHex(s.charCodeAt(i + 1)) || !isHex(s.charCodeAt(i + 2))) {
      parts.push(s[i] ?? '');
      i += 1;
      continue;
    }
    const start = i;
    const raw: number[] = [];
    while (i + 2 < s.length && s.charCodeAt(i) === 0x25 && isHex(s.charCodeAt(i + 1)) && isHex(s.charCodeAt(i + 2))) {
      raw.push(unhex(s.charCodeAt(i + 1)) << 4 | unhex(s.charCodeAt(i + 2)));
      i += 3;
    }
    let j = 0;
    while (j < raw.length) {
      const b0 = raw[j] ?? 0;
      const size = utf8RuneSize(b0);
      if (size <= 1 && b0 >= 0x80) {
        parts.push(s.slice(start + 3 * j, start + 3 * j + 3));
        j += 1;
        continue;
      }
      if (j + size > raw.length || !validUtf8Tail(raw.slice(j), size)) {
        parts.push(s.slice(start + 3 * j, start + 3 * j + 3));
        j += 1;
        continue;
      }
      const bytes = Uint8Array.from(raw.slice(j, j + size));
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (text.length === 0) {
          parts.push(s.slice(start + 3 * j, start + 3 * j + 3));
          j += 1;
          continue;
        }
        parts.push(text);
        j += size;
      } catch {
        parts.push(s.slice(start + 3 * j, start + 3 * j + 3));
        j += 1;
      }
    }
  }
  return parts.join('');
}