import { unescapeDataString } from '../dotnet/unescape.ts';
import { sanitizeWire } from '../mediatype/index.ts';

const CHARSET_CODE_PAGES: Record<string, number> = {
  'ansi_x3.4-1968': 20127, 'ansi_x3.4-1986': 20127, ascii: 20127, cp367: 20127,
  cp819: 28591, csascii: 20127, csisolatin1: 28591, ibm367: 20127,
  ibm819: 28591, 'iso-10646-ucs-2': 1200, 'iso-8859-1': 28591, 'iso-ir-100': 28591,
  'iso-ir-6': 20127, 'iso646-us': 20127, iso8859_1: 28591, 'iso_646.irv:1991': 20127,
  'iso_8859-1': 28591, 'iso_8859-1:1987': 28591, l1: 28591, latin1: 28591,
  'ucs-2': 1200, unicode: 1200, 'unicode-1-1-utf-8': 65001, 'unicode-2-0-utf-8': 65001,
  unicodefffe: 1201, us: 20127, 'us-ascii': 20127, 'utf-16': 1200,
  'utf-16be': 1201, 'utf-16le': 1200, 'utf-32': 12000, 'utf-32be': 12001,
  'utf-32le': 12000, 'utf-8': 65001, 'x-unicode-1-1-utf-8': 65001, 'x-unicode-2-0-utf-8': 65001,
};

function decodeAscii(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const c = bytes[i]!;
    out += String.fromCharCode(c >= 0x80 ? 0x3f : c);
  }
  return out;
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

function validUtf8Prefix(bytes: Uint8Array): number {
  if (bytes.length === 0) {
    return 1;
  }
  const lead = bytes[0]!;
  let size = 1;
  let low = 0x80;
  let high = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) {
    size = 2;
  } else if (lead === 0xe0) {
    size = 3;
    low = 0xa0;
  } else if (lead === 0xed) {
    size = 3;
    high = 0x9f;
  } else if (lead >= 0xe1 && lead <= 0xef) {
    size = 3;
  } else if (lead === 0xf0) {
    size = 4;
    low = 0x90;
  } else if (lead === 0xf4) {
    size = 4;
    high = 0x8f;
  } else if (lead >= 0xf1 && lead <= 0xf3) {
    size = 4;
  } else {
    return 1;
  }
  let n = 1;
  for (; n < size && n < bytes.length; n += 1) {
    const c = bytes[n]!;
    if (n === 1 && (c < low || c > high)) {
      break;
    }
    if (n > 1 && (c < 0x80 || c > 0xbf)) {
      break;
    }
  }
  return n;
}

function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let at = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (at < bytes.length) {
    const slice = bytes.subarray(at);
    let used = 0;
  let piece = '';
    for (let tryLen = Math.min(4, slice.length); tryLen >= 1; tryLen -= 1) {
      try {
        piece = decoder.decode(slice.subarray(0, tryLen));
        used = tryLen;
        break;
      } catch {
        continue;
      }
    }
    if (used === 0) {
      out += '\uFFFD';
      at += 1;
      continue;
    }
    out += piece;
    at += used;
  }
  return out;
}

function decodeUtf16(bytes: Uint8Array, bigEndian: boolean): string {
  let out = '';
  let i = 0;
  const unit = (pos: number): number => (bigEndian
    ? (bytes[pos]! << 8) | bytes[pos + 1]!
    : (bytes[pos + 1]! << 8) | bytes[pos]!);
  for (; i + 1 < bytes.length; i += 2) {
    const u = unit(i);
    if (u >= 0xd800 && u < 0xdc00 && i + 3 < bytes.length) {
      const v = unit(i + 2);
      if (v >= 0xdc00 && v <= 0xdfff) {
        const code = 0x10000 + ((u - 0xd800) << 10) + (v - 0xdc00);
        out += String.fromCodePoint(code);
        i += 2;
        continue;
      }
    }
    if (u >= 0xd800 && u <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += String.fromCharCode(u);
    }
  }
  if (i < bytes.length) {
    out += '\uFFFD';
  }
  return out;
}

function decodeUtf32(bytes: Uint8Array, bigEndian: boolean): string {
  let out = '';
  let i = 0;
  for (; i + 3 < bytes.length; i += 4) {
    const v = bigEndian
      ? (bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!
      : (bytes[i + 3]! << 24) | (bytes[i + 2]! << 16) | (bytes[i + 1]! << 8) | bytes[i]!;
    if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) {
      out += '\uFFFD';
    } else {
      out += String.fromCodePoint(v);
    }
  }
  if (i < bytes.length) {
    out += '\uFFFD';
  }
  return out;
}

const decoders: Record<number, (bytes: Uint8Array) => string> = {
  20127: decodeAscii,
  28591: decodeLatin1,
  65001: decodeUtf8,
  1200: (b) => decodeUtf16(b, false),
  1201: (b) => decodeUtf16(b, true),
  12000: (b) => decodeUtf32(b, false),
  12001: (b) => decodeUtf32(b, true),
};

function decodeExtendedValue(value: string): { text: string; ok: true } | { ok: false } {
  const parts = value.split("'");
  if (parts.length !== 3) {
    return { ok: false };
  }
  const decode = decoders[CHARSET_CODE_PAGES[parts[0]!.toLowerCase()] ?? -1];
  if (!decode) {
    return { ok: false };
  }
  const text = parts[2]!;
  let out = '';
  const run: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '%' && i + 2 < text.length && isHex(text.charCodeAt(i + 1)) && isHex(text.charCodeAt(i + 2))) {
      run.push(hex(text.charCodeAt(i + 1)) << 4 | hex(text.charCodeAt(i + 2)));
      i += 2;
      continue;
    }
    if (run.length > 0) {
      out += decode(Uint8Array.from(run));
      run.length = 0;
    }
    out += text[i];
  }
  if (run.length > 0) {
    out += decode(Uint8Array.from(run));
  }
  return { text: out, ok: true };
}

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function hex(c: number): number {
  if (c >= 0x30 && c <= 0x39) {
    return c - 0x30;
  }
  if (c >= 0x41 && c <= 0x46) {
    return c - 0x41 + 10;
  }
  return c - 0x61 + 10;
}

function removeQuotes(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1);
  }
  return value;
}

function unquoteFileName(value: string): string {
  const quoted = value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"';
  const unquoted = removeQuotes(value);
  if (!quoted || !unquoted.includes('\\')) {
    return unquoted;
  }
  let out = '';
  for (let i = 0; i < unquoted.length; i += 1) {
    if (unquoted[i] === '\\' && i + 1 < unquoted.length) {
      i += 1;
    }
    out += unquoted[i];
  }
  return out;
}

function sanitizeFileName(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) {
    name = name.slice(slash + 1);
  }
  if (name === '.' || name === '..' || name.length > 255) {
    return '';
  }
  return name;
}

interface Param {
  name: string;
  value: string;
}

function parseDispositionParams(rest: string): Param[] {
  const params: Param[] = [];
  let text = rest;
  while (text.length > 0) {
    if (text[0] === ';') {
      text = text.slice(1).trimStart();
    }
    if (text === '') {
      break;
    }
    const eq = text.indexOf('=');
    if (eq < 0) {
      return [];
    }
    const name = text.slice(0, eq).trim();
    text = text.slice(eq + 1).trim();
    let value = '';
    if (text.startsWith('"')) {
      let end = 1;
      for (; end < text.length; end += 1) {
        if (text[end] === '"' && text[end - 1] !== '\\') {
          break;
        }
      }
      value = text.slice(1, end);
      text = text.slice(end + 1);
    } else {
      const semi = text.indexOf(';');
      if (semi < 0) {
        value = text.trim();
        text = '';
      } else {
        value = text.slice(0, semi).trim();
        text = text.slice(semi);
      }
    }
    params.push({ name, value });
  }
  return params;
}

export function fileNameFromDisposition(disposition: string): string | undefined {
  const trimmed = disposition.trim();
  const semi = trimmed.indexOf(';');
  const type = semi < 0 ? trimmed : trimmed.slice(0, semi).trim();
  if (type === '' || /[\s/]/.test(type) || !/^form-data$/i.test(type)) {
    return undefined;
  }
  const params = parseDispositionParams(semi < 0 ? '' : trimmed.slice(semi));
  let name: string | undefined;
  let plain: string | undefined;
  let star: string | undefined;
  for (const param of params) {
    const key = param.name.toLowerCase();
    if (key === 'name' && name === undefined) {
      name = param.value;
    } else if (key === 'filename' && plain === undefined) {
      plain = param.value;
    } else if (key === 'filename*' && star === undefined) {
      star = param.value;
    }
  }
  if (name === undefined || removeQuotes(name) !== 'file') {
    return undefined;
  }
  let raw = '';
  let decoded = false;
  if (star !== undefined) {
    const starDecoded = decodeExtendedValue(star);
    if (starDecoded.ok) {
      raw = starDecoded.text;
      decoded = true;
    }
  }
  if (!decoded) {
    if (plain === undefined) {
      return undefined;
    }
    raw = plain;
  }
  const fileName = sanitizeFileName(unquoteFileName(raw));
  return fileName === '' ? '' : fileName;
}

export function sanitizeWireContentType(value: string): string {
  return sanitizeWire(value);
}