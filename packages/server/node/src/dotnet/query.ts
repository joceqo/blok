import { unescapeDataString } from './unescape.ts';

function asciiEqualFold(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x >= 0x41 && x <= 0x5a) {
      x += 0x20;
    }
    if (y >= 0x41 && y <= 0x5a) {
      y += 0x20;
    }
    if (x !== y) {
      return false;
    }
  }
  return true;
}

function decodeQueryPart(s: string): string {
  if (!s.includes('%') && !s.includes('+')) {
    return s;
  }
  return unescapeDataString(s.replaceAll('+', ' '));
}

/** First value for a query key, ASP.NET Core ordering. */
export function queryFirst(rawQuery: string, key: string): string {
  let query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  for (; query !== ''; ) {
    let pair = query;
    const amp = query.indexOf('&');
    if (amp >= 0) {
      pair = query.slice(0, amp);
      query = query.slice(amp + 1);
    } else {
      query = '';
    }
    let name = pair;
    let value = '';
    const eq = pair.indexOf('=');
    if (eq >= 0) {
      name = pair.slice(0, eq);
      value = pair.slice(eq + 1);
    } else if (pair === '') {
      continue;
    }
    if (asciiEqualFold(decodeQueryPart(name), key)) {
      return decodeQueryPart(value);
    }
  }
  return '';
}