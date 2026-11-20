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

function parseRanges(header: string, size: bigint): { start: bigint; length: bigint }[] | 'invalid' | 'no-overlap' {
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
  return ranges;
}

function httpLastModified(mtimeMs: number): string {
  return new Date(mtimeMs).toUTCString();
}

export async function localFileHandler(
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
  const rangeHeader = [...request.headers().getAll('range')].join(',');
  const headOnly = request.method().toUpperCase() === 'HEAD';

  response.headersMut().set('Content-Disposition', 'attachment');
  response.headersMut().set('X-Content-Type-Options', 'nosniff');

  const serveWhole = async () => {
    response.headersMut().set('Accept-Ranges', 'bytes');
    response.headersMut().set('Content-Type', contentType);
    response.headersMut().set('Content-Length', String(info.size));
    await response.start(200);
    if (!headOnly) {
      await pipelineStream(response, store.openReadStream(fileName));
    }
  };

  if (rangeHeader === '') {
    await serveWhole();
    return;
  }

  const parsed = parseRanges(rangeHeader, size);
  if (parsed === 'invalid') {
    const body = 'invalid range\n';
    response.headersMut().set('Content-Type', 'text/plain; charset=utf-8');
    response.headersMut().set('Content-Length', String(body.length));
    response.setStatus(416);
    await response.start(416);
    if (!headOnly) {
      await response.write(new TextEncoder().encode(body));
    }
    return;
  }
  if (parsed === 'no-overlap') {
    const body = 'invalid range: failed to overlap\n';
    response.headersMut().set('Content-Type', 'text/plain; charset=utf-8');
    response.headersMut().set('Content-Length', String(body.length));
    response.headersMut().set('Content-Range', `bytes */${info.size}`);
    response.setStatus(416);
    await response.start(416);
    if (!headOnly) {
      await response.write(new TextEncoder().encode(body));
    }
    return;
  }
  if (parsed.length !== 1) {
    await serveWhole();
    return;
  }
  const range = parsed[0]!;
  const end = range.start + range.length - 1n;
  response.headersMut().set('Accept-Ranges', 'bytes');
  response.headersMut().set('Content-Type', contentType);
  response.headersMut().set('Content-Range', `bytes ${range.start}-${end}/${info.size}`);
  response.headersMut().set('Content-Length', String(range.length));
  await response.start(206);
  if (!headOnly) {
    const stream = store.openReadStream(fileName, { start: Number(range.start), end: Number(end) });
    await pipelineStream(response, stream);
  }
}

async function pipelineStream(response: ResponseWriter, stream: NodeJS.ReadableStream): Promise<void> {
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    await response.write(new Uint8Array(buf));
  }
}