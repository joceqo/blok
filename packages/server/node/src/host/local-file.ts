import { createReadStream, type ReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { eqIgnoreAsciiCase, isFieldValue } from '../http/headers.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { isGenerated } from '../blob/key.ts';
import { contentTypeFor, type LocalStore } from '../blob/local.ts';
import type { HostAppOptions } from './options.ts';
import { writePlain } from '../route/respond.ts';

function applyFilesCors(options: HostAppOptions, request: Request, response: ResponseWriter): void {
  if (!options.filesCors) {
    return;
  }
  response.headersMut().add('Vary', 'Origin');
  const origin = request.headers().get('origin') ?? '';
  if (origin === '' || !isFieldValue(origin)) {
    return;
  }
  for (const candidate of options.allowedOrigins) {
    if (eqIgnoreAsciiCase(candidate.trim(), origin)) {
      response.headersMut().set('Access-Control-Allow-Origin', origin);
      response.headersMut().set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
      return;
    }
  }
}

function parseRangeNumber(value: string): bigint | undefined {
  if (!/^-?\d+$/.test(value)) {
    return undefined;
  }
  const n = BigInt(value);
  if (n < 0n) {
    return undefined;
  }
  return n;
}

type ParsedRanges = { start: bigint; length: bigint }[] | 'invalid' | 'no-overlap';

function parseRanges(header: string, size: bigint): ParsedRanges {
  if (!header.startsWith('bytes=')) {
    return 'invalid';
  }
  const parts = header.slice(6).split(',');
  if (parts.length > 16) {
    return 'invalid';
  }
  const ranges: { start: bigint; length: bigint }[] = [];
  let noOverlap = false;
  for (const part of parts) {
    const spec = part.trim();
    if (spec === '') {
      continue;
    }
    const dash = spec.indexOf('-');
    if (dash < 0) {
      return 'invalid';
    }
    const startText = spec.slice(0, dash).trim();
    const endText = spec.slice(dash + 1).trim();
    if (startText === '') {
      const suffix = parseRangeNumber(endText);
      if (!suffix || endText.startsWith('-')) {
        return 'invalid';
      }
      const use = suffix > size ? size : suffix;
      if (use === 0n) {
        noOverlap = true;
        continue;
      }
      ranges.push({ start: size - use, length: use });
      continue;
    }
    const start = parseRangeNumber(startText);
    if (start === undefined) {
      return 'invalid';
    }
    if (start >= size) {
      noOverlap = true;
      continue;
    }
    if (endText === '') {
      ranges.push({ start, length: size - start });
      continue;
    }
    const end = parseRangeNumber(endText);
    if (end === undefined || start > end) {
      return 'invalid';
    }
    const capped = end > size - 1n ? size - 1n : end;
    ranges.push({ start, length: capped - start + 1n });
  }
  if (noOverlap && ranges.length === 0) {
    return 'no-overlap';
  }
  let selected = 0n;
  for (const range of ranges) {
    if (selected > size - range.length) {
      return [];
    }
    selected += range.length;
  }
  return ranges;
}

function httpLastModified(mtimeMs: number): string {
  return new Date(mtimeMs).toUTCString();
}

function headerDate(request: Request, name: string): number | undefined {
  const joined = [...request.headers().getAll(name.toLowerCase())].join(',');
  if (joined === '') {
    return undefined;
  }
  const ms = Date.parse(joined);
  return Number.isFinite(ms) ? ms : undefined;
}

function hasWildcardTag(value: string): boolean {
  for (const part of value.split(',')) {
    if (part.trim() === '*') {
      return true;
    }
  }
  return false;
}

function preconditions(request: Request, modifiedMs: number): number {
  const ifMatch = [...request.headers().getAll('if-match')].join(',');
  if (ifMatch !== '') {
    if (!hasWildcardTag(ifMatch)) {
      return 412;
    }
  } else {
    const since = headerDate(request, 'If-Unmodified-Since');
    if (since !== undefined && modifiedMs > since) {
      return 412;
    }
  }
  const ifNoneMatch = [...request.headers().getAll('if-none-match')].join(',');
  if (ifNoneMatch !== '') {
    if (hasWildcardTag(ifNoneMatch)) {
      return 304;
    }
    return 0;
  }
  const modifiedSince = headerDate(request, 'If-Modified-Since');
  if (modifiedSince !== undefined && modifiedMs <= modifiedSince) {
    return 304;
  }
  return 0;
}

function ifRangeMatches(request: Request, modifiedMs: number): boolean {
  const value = [...request.headers().getAll('if-range')].join(',');
  if (value === '') {
    return true;
  }
  const parsed = headerDate(request, 'If-Range');
  return parsed !== undefined && parsed === modifiedMs;
}

export async function localFileHandler(
  options: HostAppOptions,
  store: LocalStore,
  request: Request,
  response: ResponseWriter,
  fileName: string,
): Promise<void> {
  try {
    await serveLocalFile(options, store, request, response, fileName);
  } catch {
    if (!request.isCancelled() && !response.started()) {
      await writePlain(request, response, 500, 'internal error\n');
    }
  }
}

async function serveLocalFile(
  options: HostAppOptions,
  store: LocalStore,
  request: Request,
  response: ResponseWriter,
  fileName: string,
): Promise<void> {
  applyFilesCors(options, request, response);
  if (
    fileName === ''
    || fileName === '.'
    || fileName === '..'
    || fileName.includes('/')
    || fileName.includes('\\')
    || !isGenerated(fileName)
  ) {
    await writePlain(request, response, 404, '404 page not found\n');
    return;
  }
  let info: Awaited<ReturnType<LocalStore['fileStat']>>;
  try {
    info = await store.fileStat(fileName);
  } catch {
    await writePlain(request, response, 404, '404 page not found\n');
    return;
  }
  if (info.isDirectory()) {
    await writePlain(request, response, 404, '404 page not found\n');
    return;
  }
  const size = BigInt(info.size);
  const contentType = contentTypeFor(fileName);
  response.headersMut().set('Last-Modified', httpLastModified(info.mtimeMs));
  response.headersMut().set('Content-Disposition', 'attachment');
  response.headersMut().set('X-Content-Type-Options', 'nosniff');
  const headOnly = request.method().toUpperCase() === 'HEAD';
  const early = preconditions(request, info.mtimeMs);
  if (early !== 0) {
    await response.start(early);
    return;
  }
  let rangeHeader = [...request.headers().getAll('range')].join(',');
  if (rangeHeader !== '' && !ifRangeMatches(request, info.mtimeMs)) {
    rangeHeader = '';
  }
  const serveWhole = async () => {
    response.headersMut().set('Accept-Ranges', 'bytes');
    response.headersMut().set('Content-Type', contentType);
    response.headersMut().set('Content-Length', String(info.size));
    await response.start(200);
    if (!headOnly && !request.isCancelled()) {
      await pipelineStream(request, response, store.openReadStream(fileName));
    }
  };
  if (rangeHeader === '') {
    await serveWhole();
    return;
  }
  const parsed = parseRanges(rangeHeader, size);
  if (parsed === 'invalid') {
    const body = 'invalid range\n';
    response.headersMut().remove('accept-ranges');
    response.headersMut().remove('last-modified');
    response.headersMut().set('Content-Type', 'text/plain; charset=utf-8');
    response.headersMut().set('Content-Length', String(body.length));
    response.setStatus(416);
    await response.start(416);
    if (!headOnly && !request.isCancelled()) {
      await response.write(new TextEncoder().encode(body));
    }
    return;
  }
  if (parsed === 'no-overlap') {
    if (size === 0n) {
      await serveWhole();
      return;
    }
    const body = 'invalid range: failed to overlap\n';
    response.headersMut().remove('accept-ranges');
    response.headersMut().remove('last-modified');
    response.headersMut().set('Content-Type', 'text/plain; charset=utf-8');
    response.headersMut().set('Content-Length', String(body.length));
    response.headersMut().set('Content-Range', `bytes */${info.size}`);
    response.setStatus(416);
    await response.start(416);
    if (!headOnly && !request.isCancelled()) {
      await response.write(new TextEncoder().encode(body));
    }
    return;
  }
  if (Array.isArray(parsed) && parsed.length === 0) {
    await serveWhole();
    return;
  }
  if (Array.isArray(parsed) && parsed.length > 1) {
    const boundary = randomBytes(16).toString('hex');
    let total = 0;
    const parts: { header: string; range: { start: bigint; length: bigint } }[] = [];
    for (const range of parsed) {
      const header = `--${boundary}\r\nContent-Range: bytes ${range.start}-${range.start + range.length - 1n}/${info.size}\r\nContent-Type: ${contentType}\r\n\r\n`;
      total += header.length + Number(range.length) + 2;
      parts.push({ header, range });
    }
    const closing = `--${boundary}--\r\n`;
    total += closing.length;
    response.headersMut().set('Content-Type', `multipart/byteranges; boundary=${boundary}`);
    response.headersMut().set('Accept-Ranges', 'bytes');
    response.headersMut().set('Content-Length', String(total));
    await response.start(206);
    if (headOnly || request.isCancelled()) {
      return;
    }
    for (const part of parts) {
      await response.write(new TextEncoder().encode(part.header));
      await pipelineStream(
        request,
        response,
        store.openReadStream(fileName, { start: Number(part.range.start), end: Number(part.range.start + part.range.length - 1n) }),
      );
      await response.write(new TextEncoder().encode('\r\n'));
    }
    await response.write(new TextEncoder().encode(closing));
    return;
  }
  const range = parsed[0]!;
  const end = range.start + range.length - 1n;
  response.headersMut().set('Accept-Ranges', 'bytes');
  response.headersMut().set('Content-Type', contentType);
  response.headersMut().set('Content-Range', `bytes ${range.start}-${end}/${info.size}`);
  response.headersMut().set('Content-Length', String(range.length));
  await response.start(206);
  if (!headOnly && !request.isCancelled()) {
    const stream = store.openReadStream(fileName, { start: Number(range.start), end: Number(end) });
    await pipelineStream(request, response, stream);
  }
}

async function pipelineStream(
  request: Request,
  response: ResponseWriter,
  stream: ReadStream,
): Promise<void> {
  try {
    for await (const chunk of stream) {
      if (request.isCancelled()) {
        stream.destroy();
        return;
      }
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      await response.write(new Uint8Array(buf));
    }
  } catch {
    stream.destroy();
  }
}