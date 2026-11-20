import {
  brotliDecompressSync,
  constants,
  gunzipSync,
  inflateRawSync,
  inflateSync,
  unzipSync,
} from 'node:zlib';

export class DecodeError extends Error {}

// --- CRC32 (IEEE / gzip) ----------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Update(sum: number, data: Buffer, start: number, end: number): number {
  let s = sum >>> 0;
  for (let i = start; i < end; i += 1) {
    s = CRC32_TABLE[(s ^ data[i]!) & 0xff]! ^ (s >>> 8);
  }
  return s >>> 0;
}

function crc32IEEE(data: Buffer): number {
  return (crc32Update(0xffffffff, data, 0, data.length) ^ 0xffffffff) >>> 0;
}

// --- Content-Encoding tokens ------------------------------------------------

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

// --- Quiet sync inflate (longest valid prefix) ------------------------------

function longestInflateRaw(buf: Buffer): Buffer {
  if (buf.length === 0) {
    return buf;
  }
  let lo = 1;
  let hi = buf.length;
  let best = Buffer.alloc(0);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = inflateRawSync(buf.subarray(0, mid));
      lo = mid + 1;
    } catch {
      hi = mid - 1;
    }
  }
  return best;
}

function longestUnzip(buf: Buffer): Buffer {
  if (buf.length === 0) {
    return buf;
  }
  let lo = 1;
  let hi = buf.length;
  let best = Buffer.alloc(0);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = unzipSync(buf.subarray(0, mid));
      lo = mid + 1;
    } catch {
      hi = mid - 1;
    }
  }
  return best;
}

function longestBrotli(buf: Buffer): Buffer {
  if (buf.length === 0) {
    return buf;
  }
  let lo = 1;
  let hi = buf.length;
  let best = Buffer.alloc(0);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = brotliDecompressSync(buf.subarray(0, mid));
      lo = mid + 1;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('excessive input') && mid < buf.length) {
        best = brotliDecompressSync(buf.subarray(0, mid));
        lo = mid + 1;
        continue;
      }
      hi = mid - 1;
    }
  }
  return best;
}

// --- Gzip header (long name/comment like zlib) ------------------------------

function checkGzipHeader(buf: Buffer, at: number): void {
  if (
    (buf.length > at && buf[at] !== 0x1f)
    || (buf.length > at + 1 && buf[at + 1] !== 0x8b)
    || (buf.length > at + 2 && buf[at + 2] !== 8)
    || (buf.length > at + 3 && (buf[at + 3]! & 0xe0) !== 0)
  ) {
    throw new DecodeError();
  }
}

function gzipHeaderLength(buf: Buffer, at: number): number | undefined {
  if (buf.length < at + 10) {
    return undefined;
  }
  checkGzipHeader(buf, at);
  const flags = buf[at + 3]!;
  let pos = at + 10;
  let sum = crc32IEEE(buf.subarray(at, at + 10));
  if ((flags & 0x04) !== 0) {
    if (buf.length < pos + 2) {
      return undefined;
    }
    const extraLen = buf.readUInt16LE(pos);
    pos += 2;
    if (buf.length < pos + extraLen) {
      return undefined;
    }
    sum = crc32Update(sum, buf, pos, pos + extraLen);
    pos += extraLen;
  }
  for (const flag of [0x08, 0x10] as const) {
    if ((flags & flag) === 0) {
      continue;
    }
    let nul = false;
    while (pos < buf.length) {
      sum = crc32Update(sum, buf, pos, pos + 1);
      if (buf[pos] === 0) {
        pos += 1;
        nul = true;
        break;
      }
      pos += 1;
    }
    if (!nul) {
      return undefined;
    }
  }
  if ((flags & 0x02) !== 0) {
    if (buf.length < pos + 2) {
      return undefined;
    }
    if (buf.readUInt16LE(pos) !== (sum & 0xffff)) {
      throw new DecodeError();
    }
    pos += 2;
  }
  return pos - at;
}

function decodeGzipMembers(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  while (at + 2 <= raw.length && raw[at] === 0x1f && raw[at + 1] === 0x8b) {
    const headerLen = gzipHeaderLength(raw, at);
    if (headerLen === undefined) {
      if (parts.length > 0) {
        throw new DecodeError();
      }
      parts.push(longestInflateRaw(raw.subarray(at + 10)));
      break;
    }
    let member: Buffer | undefined;
    let next = raw.length;
    for (let end = raw.length; end > at + headerLen + 2; end -= 1) {
      try {
        const trial = gunzipSync(raw.subarray(at, end));
        if (end < at + headerLen + 8) {
          continue;
        }
        const crc = raw.readUInt32LE(end - 8);
        const size = raw.readUInt32LE(end - 4);
        if (crc === crc32IEEE(trial) && size === trial.length) {
          member = trial;
          next = end;
          break;
        }
      } catch {
        // try a shorter slice
      }
    }
    if (member === undefined) {
      if (parts.length > 0) {
        throw new DecodeError();
      }
      try {
        member = gunzipSync(raw.subarray(at), { finishFlush: constants.Z_SYNC_FLUSH });
        next = raw.length;
      } catch {
        const quiet = longestInflateRaw(raw.subarray(at + headerLen));
        if (quiet.length > 0) {
          parts.push(quiet);
        }
        break;
      }
    }
    parts.push(member);
    at = next;
    if (at >= raw.length || raw[at] !== 0x1f || raw[at + 1] !== 0x8b) {
      break;
    }
  }
  return Buffer.concat(parts);
}

// --- Public API -------------------------------------------------------------

export function decodeGzip(buf: Buffer): Buffer {
  if (buf.length === 0) {
    return buf;
  }
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new DecodeError();
  }
  try {
    const decoded = decodeGzipMembers(buf);
    if (decoded.length === 0) {
      throw new DecodeError();
    }
    return decoded;
  } catch (e) {
    if (e instanceof DecodeError) {
      throw e;
    }
    try {
      return gunzipSync(buf, { finishFlush: constants.Z_SYNC_FLUSH });
    } catch {
      throw new DecodeError();
    }
  }
}

export function decodeDeflate(buf: Buffer): Buffer {
  if (buf.length === 0) {
    return buf;
  }
  try {
    return unzipSync(buf);
  } catch {
    try {
      return inflateSync(buf, { finishFlush: constants.Z_SYNC_FLUSH });
    } catch {
      throw new DecodeError();
    }
  }
}

export function decodeBr(buf: Buffer): Buffer {
  if (buf.length === 0) {
    return buf;
  }
  try {
    return brotliDecompressSync(buf);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('excessive input') || msg.includes('unexpected end')) {
      return longestBrotli(buf);
    }
    throw new DecodeError();
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