import { brotliDecompressSync, gunzipSync, inflateRawSync, unzipSync } from 'node:zlib';

export class DecodeError extends Error {}

function quietDecode(fn: () => Buffer): Buffer {
  try {
    return fn();
  } catch {
    return Buffer.alloc(0);
  }
}

export function decodeGzip(buf: Buffer): Buffer {
  try {
    return gunzipSync(buf);
  } catch {
    throw new DecodeError();
  }
}

export function decodeDeflate(buf: Buffer): Buffer {
  if (buf.length === 0) {
    return buf;
  }
  try {
    return inflateRawSync(buf);
  } catch {
    try {
      return unzipSync(buf);
    } catch {
      throw new DecodeError();
    }
  }
}

export function decodeBr(buf: Buffer): Buffer {
  try {
    return brotliDecompressSync(buf);
  } catch {
    return quietDecode(() => brotliDecompressSync(buf));
  }
}

export function decodeBody(encoding: string, raw: Buffer): Buffer {
  switch (encoding.toLowerCase()) {
    case 'gzip':
      return decodeGzip(raw);
    case 'deflate':
    case 'x-deflate':
      return decodeDeflate(raw);
    case 'br':
      return decodeBr(raw);
    default:
      throw new DecodeError();
  }
}

export function isToken(item: string): boolean {
  for (let i = 0; i < item.length; i += 1) {
    const c = item.charCodeAt(i);
    if (
      !(c >= 0x61 && c <= 0x7a)
      && !(c >= 0x41 && c <= 0x5a)
      && !(c >= 0x30 && c <= 0x39)
      && '!#$%&\'*+-.^_`|~'.indexOf(String.fromCharCode(c)) < 0
    ) {
      return false;
    }
  }
  return item.length > 0;
}

export function encodingTokens(line: string): string[] | undefined {
  const tokens: string[] = [];
  for (const item of line.split(',')) {
    const trimmed = item.trim();
    if (trimmed === '') {
      continue;
    }
    if (!isToken(trimmed)) {
      return undefined;
    }
    tokens.push(trimmed);
  }
  return tokens;
}