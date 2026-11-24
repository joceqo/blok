/** Kestrel's request head: the request line, the header block, its limits and its grammar. */

import { Headers } from './headers.ts';

/** The request line counts its line end. */
export const MAX_REQUEST_LINE = 8 << 10;
/** Every byte after the request line, blank line included. */
export const MAX_HEADER_BLOCK = (32 << 10) + 2;
/** Header lines, Host included. */
export const MAX_HEADER_COUNT = 100;

export const Version = {
  Http10: 'HTTP/1.0',
  Http11: 'HTTP/1.1',
} as const;
export type Version = (typeof Version)[keyof typeof Version];

/** RFC 9112 section 3.2 request-target forms. */
export const TargetForm = {
  Origin: 'origin',
  Absolute: 'absolute',
  Authority: 'authority',
  Asterisk: 'asterisk',
} as const;
export type TargetForm = (typeof TargetForm)[keyof typeof TargetForm];

export interface Head {
  method: string;
  target: string;
  form: TargetForm;
  path: string;
  query: string;
  version: Version;
  headers: Headers;
  /** Bytes of the header lines and the blank line: a trailer counts on. */
  headerBytes: number;
}

/** Why Kestrel refuses a head. Each is a bare answer and a close. */
export type Refusal =
  | { kind: 'status'; status: number }
  | { kind: 'goaway' }
  | { kind: 'method'; allow: string };

export type Parse =
  | { kind: 'incomplete' }
  | { kind: 'done'; head: Head; consumed: number }
  | { kind: 'refused'; refusal: Refusal };

interface RequestLine {
  method: string;
  target: string;
  version: Version;
  form: TargetForm;
  path: string;
  query: string;
}

const BAD_REQUEST: Refusal = { kind: 'status', status: 400 };

/**
 * What one head's parse has seen so far. A slow head is scanned once: each
 * call resumes where the last stopped.
 */
export class HeadScan {
  private start: number | undefined;
  private lineStart = 0;
  private scanned = 0;
  private line: RequestLine | undefined;
  private headerBytes = 0;
  private headers = new Headers();
  private hostLines = 0;
  private host = '';

  static new(): HeadScan {
    return new HeadScan();
  }

  /**
   * Reads the head at the front of buf. CR and LF before the request line
   * are skipped; `consumed` counts them. buf must only grow between calls.
   */
  parse(buf: Uint8Array): Parse {
    if (this.start === undefined) {
      let skip = 0;
      while (skip < buf.length && (buf[skip] === 0x0d || buf[skip] === 0x0a)) {
        skip += 1;
      }
      if (skip === buf.length) {
        return { kind: 'incomplete' };
      }
      this.start = skip;
      this.lineStart = skip;
    }
    for (;;) {
      const from = this.lineStart + this.scanned;
      let offset = -1;
      for (let i = from; i < buf.length; i += 1) {
        if (buf[i] === 0x0a) {
          offset = i - from;
          break;
        }
      }
      const pending = buf.length - this.lineStart;
      if (offset < 0) {
        this.scanned = pending;
        if (this.line === undefined && pending >= MAX_REQUEST_LINE) {
          return { kind: 'refused', refusal: { kind: 'status', status: 414 } };
        }
        if (this.line !== undefined && this.headerBytes + pending >= MAX_HEADER_BLOCK) {
          return { kind: 'refused', refusal: { kind: 'status', status: 431 } };
        }
        return { kind: 'incomplete' };
      }
      const end = from + offset + 1;
      const line = buf.subarray(this.lineStart, end);
      if (line.length < 2 || line[line.length - 2] !== 0x0d) {
        return { kind: 'refused', refusal: BAD_REQUEST };
      }
      this.lineStart = end;
      this.scanned = 0;
      if (this.line === undefined) {
        if (line.length > MAX_REQUEST_LINE) {
          return { kind: 'refused', refusal: { kind: 'status', status: 414 } };
        }
        const parsed = parseRequestLine(content(line));
        if ('refusal' in parsed) {
          return { kind: 'refused', refusal: parsed.refusal };
        }
        this.line = parsed.line;
        continue;
      }
      this.headerBytes += line.length;
      if (this.headerBytes > MAX_HEADER_BLOCK) {
        return { kind: 'refused', refusal: { kind: 'status', status: 431 } };
      }
      const text = content(line);
      if (text.length === 0) {
        const finished = this.finish();
        if ('refusal' in finished) {
          return { kind: 'refused', refusal: finished.refusal };
        }
        return { kind: 'done', head: finished.head, consumed: end };
      }
      if (this.headers.len() >= MAX_HEADER_COUNT) {
        return { kind: 'refused', refusal: { kind: 'status', status: 431 } };
      }
      const header = this.headerLine(text);
      if (header) {
        return { kind: 'refused', refusal: header };
      }
    }
  }

  private headerLine(line: Uint8Array): Refusal | undefined {
    const first = line[0];
    if (first === 0x20 || first === 0x09) {
      return BAD_REQUEST;
    }
    let colon = -1;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === 0x3a) {
        colon = i;
        break;
      }
    }
    if (colon < 0) {
      return BAD_REQUEST;
    }
    const nameBytes = line.subarray(0, colon);
    const rawValue = line.subarray(colon + 1);
    if (nameBytes.length === 0 || !everyByte(nameBytes, isNameByte)) {
      return BAD_REQUEST;
    }
    const valueBytes = trimBytes(rawValue);
    for (let i = 0; i < valueBytes.length; i += 1) {
      const b = valueBytes[i];
      if (b === 0 || b === 0x0d) {
        return BAD_REQUEST;
      }
    }
    const value = utf8(valueBytes);
    if (value === undefined) {
      return BAD_REQUEST;
    }
    const name = latin1(nameBytes);
    if (eqAscii(name, 'host')) {
      this.hostLines += 1;
      this.host = value;
    }
    this.headers.add(name, value);
    return undefined;
  }

  private finish(): { head: Head } | { refusal: Refusal } {
    const line = this.line;
    if (!line) {
      return { refusal: BAD_REQUEST };
    }
    this.line = undefined;
    const headers = this.headers;
    this.headers = new Headers();
    if (
      this.hostLines > 1 ||
      (this.hostLines === 0 && line.version === Version.Http11) ||
      !validHost(this.host)
    ) {
      return { refusal: BAD_REQUEST };
    }
    if (line.form === TargetForm.Absolute) {
      if (this.hostLines > 0 && !absoluteMatchesHost(line.target, this.host)) {
        return { refusal: BAD_REQUEST };
      }
    } else if (line.form === TargetForm.Authority) {
      if (this.host !== line.target) {
        return { refusal: BAD_REQUEST };
      }
    }
    const framing = checkFraming(headers);
    if (framing) {
      return { refusal: framing };
    }
    return {
      head: {
        method: line.method,
        target: line.target,
        form: line.form,
        path: line.path,
        query: line.query,
        version: line.version,
        headers,
        headerBytes: this.headerBytes,
      },
    };
  }
}

function content(line: Uint8Array): Uint8Array {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0a) {
    end -= 1;
  }
  if (end > 0 && line[end - 1] === 0x0d) {
    end -= 1;
  }
  return line.subarray(0, end);
}

function trimBytes(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length && (value[start] === 0x20 || value[start] === 0x09)) {
    start += 1;
  }
  let end = value.length;
  while (end > start && (value[end - 1] === 0x20 || value[end - 1] === 0x09)) {
    end -= 1;
  }
  return value.subarray(start, end);
}

/** Kestrel takes any name byte but NUL, HT, LF, CR, SP and bytes over 0x7F. */
function isNameByte(b: number): boolean {
  return b !== 0 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x20 && b < 0x80;
}

/** RFC 9110 tchar. */
export function isTokenByte(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    TOKEN_EXTRA.has(b)
  );
}

const TOKEN_EXTRA = new Set<number>([
  0x21, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2a, 0x2b, 0x2d, 0x2e, 0x5e, 0x5f, 0x60, 0x7c, 0x7e,
]);

function parseRequestLine(line: Uint8Array): { line: RequestLine } | { refusal: Refusal } {
  let space = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === 0x20) {
      space = i;
      break;
    }
  }
  if (space < 0) {
    return { refusal: BAD_REQUEST };
  }
  const methodBytes = line.subarray(0, space);
  if (methodBytes.length === 0 || !everyByte(methodBytes, isTokenByte)) {
    return { refusal: BAD_REQUEST };
  }
  let offset = space + 1;
  const next = line[offset];
  if (next === undefined || next === 0x20 || next === 0x3f || next === 0x25) {
    return { refusal: BAD_REQUEST };
  }
  let targetEnd = -1;
  for (let i = offset; i < line.length; i += 1) {
    if (line[i] === 0x20) {
      targetEnd = i;
      break;
    }
  }
  if (targetEnd < 0) {
    return { refusal: BAD_REQUEST };
  }
  const targetBytes = line.subarray(offset, targetEnd);
  offset = targetEnd + 1;
  while (line[offset] === 0x20) {
    offset += 1;
  }
  if (offset >= line.length) {
    return { refusal: BAD_REQUEST };
  }
  const versionText = line.subarray(offset);
  if (
    bytesEqual(methodBytes, ASCII_PRI) &&
    bytesEqual(targetBytes, ASCII_STAR) &&
    bytesEqual(versionText, ASCII_HTTP20)
  ) {
    return { refusal: { kind: 'goaway' } };
  }
  let version: Version;
  if (bytesEqual(versionText, ASCII_HTTP11)) {
    version = Version.Http11;
  } else if (bytesEqual(versionText, ASCII_HTTP10)) {
    version = Version.Http10;
  } else if (versionText.length === 8) {
    return { refusal: { kind: 'status', status: 505 } };
  } else {
    return { refusal: BAD_REQUEST };
  }
  for (let i = 0; i < targetBytes.length; i += 1) {
    const b = targetBytes[i] ?? 0;
    if (b === 0 || b >= 0x80) {
      return { refusal: BAD_REQUEST };
    }
  }
  const method = latin1(methodBytes);
  const target = latin1(targetBytes);
  const form = targetForm(method, target);
  if ('refusal' in form) {
    return form;
  }
  return {
    line: {
      method,
      target,
      version,
      form: form.form,
      path: form.path,
      query: form.query,
    },
  };
}

const ASCII_PRI = Uint8Array.from([0x50, 0x52, 0x49]);
const ASCII_STAR = Uint8Array.from([0x2a]);
const ASCII_HTTP20 = latin1Bytes('HTTP/2.0');
const ASCII_HTTP11 = latin1Bytes('HTTP/1.1');
const ASCII_HTTP10 = latin1Bytes('HTTP/1.0');

function targetForm(
  method: string,
  target: string,
): { form: TargetForm; path: string; query: string } | { refusal: Refusal } {
  if (target.includes('#')) {
    return { refusal: BAD_REQUEST };
  }
  if (target.startsWith('/')) {
    const [path, query] = splitQuery(target);
    return { form: TargetForm.Origin, path, query };
  }
  if (target === '*') {
    if (method !== 'OPTIONS') {
      return { refusal: { kind: 'method', allow: 'OPTIONS' } };
    }
    return { form: TargetForm.Asterisk, path: '', query: '' };
  }
  const rest = stripScheme(target);
  if (rest !== undefined) {
    const authorityEnd = indexOfAny(rest, ['/', '?']);
    const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
    const split = splitAuthority(authority);
    if (!split || split.host.length === 0 || split.host.includes('%')) {
      return { refusal: BAD_REQUEST };
    }
    const after = authorityEnd < 0 ? '' : rest.slice(authorityEnd);
    const [pathText, query] = splitQuery(after);
    const path = pathText.length === 0 ? '/' : pathText;
    return { form: TargetForm.Absolute, path, query };
  }
  if (method !== 'CONNECT') {
    for (let i = 0; i < target.length; i += 1) {
      if (!isPlainAuthorityByte(target.charCodeAt(i))) {
        return { refusal: BAD_REQUEST };
      }
    }
    return { refusal: { kind: 'method', allow: 'CONNECT' } };
  }
  if (!validHost(target)) {
    return { refusal: BAD_REQUEST };
  }
  return { form: TargetForm.Authority, path: '', query: '' };
}

function stripScheme(target: string): string | undefined {
  if (target.startsWith('http://')) {
    return target.slice('http://'.length);
  }
  if (target.startsWith('https://')) {
    return target.slice('https://'.length);
  }
  return undefined;
}

function isPlainAuthorityByte(b: number): boolean {
  return isAsciiAlnum(b) || b === 0x2d || b === 0x2e || b === 0x3a || b === 0x40 || b === 0x5b || b === 0x5d;
}

function splitQuery(target: string): [string, string] {
  const at = target.indexOf('?');
  if (at < 0) {
    return [target, ''];
  }
  return [target.slice(0, at), target.slice(at)];
}

function splitAuthority(authority: string): { host: string; port: string } | undefined {
  const at = authority.lastIndexOf('@');
  const rest = at >= 0 ? authority.slice(at + 1) : authority;
  let host: string;
  let port: string;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) {
      return undefined;
    }
    const tail = rest.slice(end + 1);
    if (tail.startsWith(':')) {
      host = rest.slice(0, end + 1);
      port = tail.slice(1);
    } else if (tail.length === 0) {
      host = rest.slice(0, end + 1);
      port = '';
    } else {
      return undefined;
    }
  } else {
    const colon = rest.indexOf(':');
    if (colon >= 0) {
      host = rest.slice(0, colon);
      port = rest.slice(colon + 1);
    } else {
      host = rest;
      port = '';
    }
  }
  if (!asciiDigits(port)) {
    return undefined;
  }
  if (port.length > 0 && !fitsU16(port)) {
    return undefined;
  }
  return { host, port };
}

function absoluteMatchesHost(target: string, hostHeader: string): boolean {
  let defaultPort: number;
  let rest: string;
  if (target.startsWith('http://')) {
    defaultPort = 80;
    rest = target.slice('http://'.length);
  } else if (target.startsWith('https://')) {
    defaultPort = 443;
    rest = target.slice('https://'.length);
  } else {
    defaultPort = 443;
    rest = target;
  }
  const authorityEnd = indexOfAny(rest, ['/', '?']);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const split = splitAuthority(authority);
  if (!split) {
    return false;
  }
  const port = split.port.length === 0 ? defaultPort : Number(split.port);
  let printed = split.host.toLowerCase();
  if (port !== defaultPort) {
    printed += `:${port}`;
  }
  return hostHeader === printed || (port === defaultPort && hostHeader === `${printed}:${defaultPort}`);
}

/** Kestrel's Host grammar. An empty value is valid. */
export function validHost(host: string): boolean {
  const bytes = latin1Bytes(host);
  if (bytes.length === 0) {
    return true;
  }
  let after: number;
  const first = bytes[0] ?? 0;
  if (first === 0x5b) {
    let end = -1;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0x5d) {
        end = i;
        break;
      }
    }
    if (end < 0 || end < 4) {
      return false;
    }
    for (let i = 1; i < end; i += 1) {
      const b = bytes[i] ?? 0;
      if (!isAsciiHex(b) && b !== 0x3a && b !== 0x2e) {
        return false;
      }
    }
    after = end + 1;
  } else {
    if (first === 0x3a) {
      return false;
    }
    let stop = bytes.length;
    for (let i = 0; i < bytes.length; i += 1) {
      if (!isHostByte(bytes[i] ?? 0)) {
        stop = i;
        break;
      }
    }
    after = stop;
  }
  const tail = bytes.subarray(after);
  if (tail.length === 0) {
    return true;
  }
  if (tail[0] !== 0x3a || tail.length < 2) {
    return false;
  }
  for (let i = 1; i < tail.length; i += 1) {
    if (!isAsciiDigit(tail[i] ?? 0)) {
      return false;
    }
  }
  return true;
}

function isHostByte(b: number): boolean {
  return isAsciiAlnum(b) || HOST_EXTRA.has(b);
}

const HOST_EXTRA = new Set<number>([
  0x21, 0x24, 0x26, 0x27, 0x28, 0x29, 0x2d, 0x2e, 0x5f, 0x7e,
]);

function checkFraming(headers: Headers): Refusal | undefined {
  const lengths = [...headers.getAll('content-length')];
  if (lengths.length > 1) {
    return BAD_REQUEST;
  }
  const value = lengths[0];
  if (value !== undefined && parseContentLength(value) === undefined) {
    return BAD_REQUEST;
  }
  if (headers.contains('transfer-encoding') && !finalCodingIsChunked(headers)) {
    return BAD_REQUEST;
  }
  return undefined;
}

const I64_MAX = 9223372036854775807n;

/**
 * One optional '+', or one '-' before zeros only, then decimal digits that
 * fit an i64.
 */
export function parseContentLength(value: string): bigint | undefined {
  let negative = false;
  let digits = value;
  if (digits.startsWith('-')) {
    negative = true;
    digits = digits.slice(1);
  } else if (digits.startsWith('+')) {
    digits = digits.slice(1);
  }
  if (digits.length === 0 || !asciiDigits(digits)) {
    return undefined;
  }
  if (negative && !zerosOnly(digits)) {
    return undefined;
  }
  const magnitude = BigInt(digits);
  if (magnitude > I64_MAX) {
    return undefined;
  }
  return magnitude;
}

/** The last coding, over every Transfer-Encoding line, is "chunked". */
export function finalCodingIsChunked(headers: Headers): boolean {
  let last: string | undefined;
  for (const value of headers.getAll('transfer-encoding')) {
    const trimmed = trimAscii(value, ' \t');
    for (const part of trimmed.split(',')) {
      const coding = trimAscii(part, ' ');
      if (coding.length > 0) {
        last = coding;
      }
    }
  }
  return last !== undefined && eqAscii(last, 'chunked');
}

function trimAscii(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value.charAt(start))) {
    start += 1;
  }
  while (end > start && chars.includes(value.charAt(end - 1))) {
    end -= 1;
  }
  return value.slice(start, end);
}

function eqAscii(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    const a = left.charCodeAt(i);
    const b = right.charCodeAt(i);
    const al = a >= 0x41 && a <= 0x5a ? a + 32 : a;
    const bl = b >= 0x41 && b <= 0x5a ? b + 32 : b;
    if (al !== bl) {
      return false;
    }
  }
  return true;
}

function everyByte(bytes: Uint8Array, pred: (b: number) => boolean): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (!pred(bytes[i] ?? 0)) {
      return false;
    }
  }
  return true;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

export function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function indexOfAny(text: string, chars: readonly string[]): number {
  let at = -1;
  for (const char of chars) {
    const found = text.indexOf(char);
    if (found >= 0 && (at < 0 || found < at)) {
      at = found;
    }
  }
  return at;
}

function asciiDigits(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (!isAsciiDigit(text.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function zerosOnly(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 0x30) {
      return false;
    }
  }
  return true;
}

function fitsU16(text: string): boolean {
  const value = BigInt(text);
  return value <= 65535n;
}

function isAsciiDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function isAsciiHex(b: number): boolean {
  return isAsciiDigit(b) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
}

function isAsciiAlnum(b: number): boolean {
  return isAsciiDigit(b) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}
