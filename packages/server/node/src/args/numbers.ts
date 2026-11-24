/** C# host error quoting: no escaping inside. */
export function csQuote(value: string): string {
  return `"${value}"`;
}

function digit(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  if (code >= 0x61 && code <= 0x7a) {
    return code - 0x61 + 10;
  }
  if (code >= 0x41 && code <= 0x5a) {
    return code - 0x41 + 10;
  }
  return -1;
}

/** Hand port of Go/C# TryParseBaseZeroInt64. */
export function parseBaseZeroInt64(value: string): number | undefined {
  if (value.length === 0) {
    return undefined;
  }
  let index = 0;
  let negative = false;
  if (value.charCodeAt(0) === 0x2b || value.charCodeAt(0) === 0x2d) {
    negative = value.charCodeAt(0) === 0x2d;
    index += 1;
    if (index >= value.length) {
      return undefined;
    }
  }
  let base = 10;
  let explicitPrefix = false;
  if (value.charCodeAt(index) === 0x30) {
    base = 8;
    if (index + 1 < value.length) {
      switch (value.charCodeAt(index + 1) | 0x20) {
        case 0x62:
          base = 2;
          explicitPrefix = true;
          break;
        case 0x6f:
          base = 8;
          explicitPrefix = true;
          break;
        case 0x78:
          base = 16;
          explicitPrefix = true;
          break;
        default:
          break;
      }
      if (explicitPrefix) {
        index += 2;
      }
    }
  }
  const digitsStart = index;
  let digitSeen = false;
  let previousUnderscore = false;
  let limit = (1n << 63n) - 1n;
  if (negative) {
    limit = 1n << 63n;
  }
  let magnitude = 0n;
  for (; index < value.length; index += 1) {
    const c = value.charCodeAt(index);
    if (c === 0x5f) {
      const followsPrefix = explicitPrefix && !digitSeen && index === digitsStart;
      const next = index + 1 < value.length ? digit(value.charCodeAt(index + 1)) : -1;
      if ((!digitSeen && !followsPrefix) || previousUnderscore || next < 0 || BigInt(next) >= BigInt(base)) {
        return undefined;
      }
      previousUnderscore = true;
      continue;
    }
    const d = digit(c);
    if (d < 0 || BigInt(d) >= BigInt(base) || magnitude > (limit - BigInt(d)) / BigInt(base)) {
      return undefined;
    }
    magnitude = magnitude * BigInt(base) + BigInt(d);
    digitSeen = true;
    previousUnderscore = false;
  }
  if (!digitSeen) {
    return undefined;
  }
  if (negative) {
    return Number(-magnitude);
  }
  return Number(magnitude);
}