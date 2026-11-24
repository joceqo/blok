import { queryFirst } from '../dotnet/query.ts';
import { keyFromPublicUrl } from '../blob/key.ts';
import type { ReadableBlobStore } from '../blob/store.ts';
import {
  OutboundFailure,
  encoded,
  isOutboundFailure,
  type ByteRange,
  type OutboundFetcher,
  upstreamExtent,
} from '../outbound/fetcher.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { fetchCaller, hopBudget } from './guard.ts';
import type { HostAppOptions } from './options.ts';
import { writePlain } from '../route/respond.ts';

const PDF_CHECK_BYTES = 1024;
const PDF_CHECK_ENTRIES = 256;
const PDF_CHECK_TTL_MS = 10 * 60 * 1000;
const FILE_BYTES_ANSWER_BYTES = 1 << 20;
const PDF_MAGIC = new TextEncoder().encode('%PDF-');

class PdfCheckCache {
  private readonly order: string[] = [];
  private readonly entries = new Map<string, number>();

  constructor(readonly now: () => number = () => Date.now()) {}

  has(url: string): boolean {
    const at = this.entries.get(url);
    if (at === undefined) {
      return false;
    }
    if (this.now() - at >= PDF_CHECK_TTL_MS) {
      this.entries.delete(url);
      const index = this.order.indexOf(url);
      if (index >= 0) {
        this.order.splice(index, 1);
      }
      return false;
    }
    return true;
  }

  add(url: string): void {
    if (this.entries.has(url)) {
      this.entries.set(url, this.now());
      const index = this.order.indexOf(url);
      if (index >= 0) {
        this.order.splice(index, 1);
      }
      this.order.unshift(url);
      return;
    }
    this.entries.set(url, this.now());
    this.order.unshift(url);
    if (this.order.length > PDF_CHECK_ENTRIES) {
      const oldest = this.order.pop();
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }
}

const pdfChecks = new PdfCheckCache();

function requestedRange(request: Request): ByteRange | undefined {
  const values = [...request.headers().getAll('range')];
  if (values.length !== 1) {
    return undefined;
  }
  const spec = values[0]!;
  if (!spec.startsWith('bytes=')) {
    return undefined;
  }
  const range = spec.slice(6);
  const dash = range.indexOf('-');
  if (dash < 0) {
    return undefined;
  }
  const startText = range.slice(0, dash);
  const endText = range.slice(dash + 1);
  const start = Number.parseInt(startText, 10);
  if (!/^\d+$/.test(startText)) {
    return undefined;
  }
  if (endText === '') {
    return { start, end: -1 };
  }
  const end = Number.parseInt(endText, 10);
  if (!/^\d+$/.test(endText) || end < start) {
    return undefined;
  }
  return { start, end };
}

function writePdfHead(
  response: ResponseWriter,
  status: number,
  start: number,
  length: number,
  total: number,
): void {
  const headers = response.headersMut();
  headers.set('Content-Type', 'application/pdf');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', 'sandbox');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
  headers.set('Vary', 'Origin, Authorization');
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('Content-Length', String(length));
  if (status === 206) {
    const size = total < 0 ? '*' : String(total);
    headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${size}`);
  }
  response.setStatus(status);
}

async function serveStoredPdf(
  store: ReadableBlobStore,
  options: HostAppOptions,
  key: string,
  byteRange: ByteRange | undefined,
  request: Request,
  response: ResponseWriter,
): Promise<void> {
  let info: Awaited<ReturnType<ReadableBlobStore['fileStat']>>;
  try {
    info = await store.fileStat(key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await writePlain(request, response, 502, 'storage unavailable\n');
      return;
    }
    await writePlain(request, response, 404, 'not found\n');
    return;
  }
  if (info.isDirectory()) {
    await writePlain(request, response, 404, 'not found\n');
    return;
  }
  const size = info.size;
  if (size > options.fileBytesMaxBytes) {
    await writePlain(request, response, 413, 'file too large\n');
    return;
  }
  const head = Buffer.alloc(PDF_CHECK_BYTES);
  const stream = store.openReadStream(key, { start: 0, end: PDF_CHECK_BYTES - 1 });
  let read = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    buf.copy(head, read, 0, Math.min(buf.length, PDF_CHECK_BYTES - read));
    read = Math.min(PDF_CHECK_BYTES, read + buf.length);
  }
  if (!Buffer.from(head.subarray(0, read)).includes(PDF_MAGIC)) {
    await writePlain(request, response, 415, 'not a pdf\n');
    return;
  }
  let status = 200;
  let start = 0;
  let length = size;
  if (byteRange !== undefined) {
    if (byteRange.start >= size) {
      response.headersMut().set('Content-Range', `bytes */${size}`);
      await writePlain(request, response, 416, 'range not satisfiable\n');
      return;
    }
    let end = size - 1;
    if (byteRange.end >= 0 && byteRange.end < end) {
      end = byteRange.end;
    }
    status = 206;
    start = byteRange.start;
    length = end - byteRange.start + 1;
  }
  if (length > FILE_BYTES_ANSWER_BYTES) {
    await writePlain(request, response, 413, 'range too large\n');
    return;
  }
  writePdfHead(response, status, start, length, size);
  await response.start(status);
  if (request.method().toUpperCase() === 'HEAD') {
    return;
  }
  const readStream = store.openReadStream(key, { start, end: start + length - 1 });
  for await (const chunk of readStream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    await response.write(new Uint8Array(buf));
  }
}

async function probePdf(
  fetcher: OutboundFetcher,
  options: HostAppOptions,
  request: Request,
  url: string,
): Promise<boolean> {
  const fetched = await fetcher.get(url, {
    timeoutMs: 10_000,
    maxBytes: PDF_CHECK_BYTES,
    maxRedirects: 5,
    truncate: true,
    hop: hopBudget(options, request),
    caller: fetchCaller(options, request),
    range: { start: 0, end: PDF_CHECK_BYTES - 1 },
  });
  try {
    if (fetched.statusCode < 200 || fetched.statusCode > 299 || encoded(fetched.headers)) {
      return false;
    }
    return Buffer.from(fetched.body).includes(PDF_MAGIC);
  } finally {
    fetched.release();
  }
}

async function serveRemotePdf(
  options: HostAppOptions,
  request: Request,
  response: ResponseWriter,
  target: string,
  byteRange: ByteRange | undefined,
): Promise<void> {
  const failed = async () => {
    if (!request.cancelToken().isCancelled()) {
      await writePlain(request, response, 502, 'the URL could not be fetched\n');
    }
  };
  try {
    const fetched = await options.fetcher.get(target, {
      timeoutMs: 120_000,
      maxBytes: FILE_BYTES_ANSWER_BYTES,
      maxRedirects: 5,
    hop: hopBudget(options, request),
    caller: fetchCaller(options, request),
    upload: true,
    range: byteRange,
    });
    const extent = upstreamExtent(fetched);
    if (
      !extent.ok
      || fetched.statusCode < 200
      || fetched.statusCode > 299
      || encoded(fetched.headers)
    ) {
      await failed();
      return;
    }
    const total = extent.total >= 0 ? extent.total : fetched.body.length;
    if (total > options.fileBytesMaxBytes) {
      await writePlain(request, response, 413, 'file too large\n');
      return;
    }
    if (!pdfChecks.has(fetched.finalUrl)) {
      const head = fetched.body.subarray(0, Math.min(fetched.body.length, PDF_CHECK_BYTES));
      if (extent.start !== 0 || !Buffer.from(head).includes(PDF_MAGIC)) {
        if (!hopBudget(options, request)()) {
          await writePlain(request, response, 429, 'rate limit exceeded\n');
          return;
        }
        const ok = await probePdf(options.fetcher, options, request, fetched.finalUrl);
        if (!ok) {
          await writePlain(request, response, 415, 'not a pdf\n');
          return;
        }
      }
      pdfChecks.add(fetched.finalUrl);
    }
    const status = fetched.statusCode === 206 ? 206 : 200;
    writePdfHead(response, status, extent.start, fetched.body.length, total);
    await response.start(status);
    if (request.method().toUpperCase() === 'HEAD') {
      return;
    }
    await response.write(fetched.body);
    fetched.release();
  } catch (error) {
    if (isOutboundFailure(error, OutboundFailure.TooLarge)) {
      await writePlain(request, response, 413, 'range too large\n');
      return;
    }
    if (isOutboundFailure(error, OutboundFailure.RateLimited)) {
      await writePlain(request, response, 429, 'rate limit exceeded\n');
      return;
    }
    await failed();
  }
}

export async function fileBytesHandler(
  options: HostAppOptions,
  store: ReadableBlobStore | undefined,
  request: Request,
  response: ResponseWriter,
): Promise<void> {
  const q = request.query();
  const target = queryFirst(q.startsWith('?') ? q.slice(1) : q, 'url');
  if (target === '') {
    await writePlain(request, response, 400, 'expected ?url=...\n');
    return;
  }
  const byteRange = requestedRange(request);
  if (store !== undefined) {
    const key = keyFromPublicUrl(options.publicUrl, target);
    if (key !== undefined) {
      await serveStoredPdf(store, options, key, byteRange, request, response);
      return;
    }
  }
  await serveRemotePdf(options, request, response, target, byteRange);
}