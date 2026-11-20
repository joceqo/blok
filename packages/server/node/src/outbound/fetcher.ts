import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { OutboundPermits } from './permits.ts';
import { rawGet } from './raw-fetch.ts';
import { readBounded } from './read-body.ts';

export const USER_AGENT = 'blok-server (+https://blokeditor.com)';

export enum OutboundFailure {
  Blocked = 'Blocked',
  TooLarge = 'TooLarge',
  TimedOut = 'TimedOut',
  TooManyRedirects = 'TooManyRedirects',
  RateLimited = 'RateLimited',
  UnsupportedContentEncoding = 'UnsupportedContentEncoding',
}

export class OutboundError extends Error {
  constructor(readonly failure: OutboundFailure) {
    super('Outbound destination is not permitted.');
  }
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  hop?: () => boolean;
  truncate?: boolean;
  upload?: boolean;
  caller?: string;
  range?: ByteRange;
}

export interface FetchResponse {
  statusCode: number;
  body: Uint8Array;
  contentType: string;
  finalUrl: string;
  headers: Record<string, string[]>;
  redirects: number;
  release(): void;
}

export interface OutboundPolicy {
  validate(raw: string, base?: URL): URL;
}

export class ExactOriginPolicy implements OutboundPolicy {
  readonly exactOrigin = true;

  constructor(
    readonly origin: string,
    readonly port: number,
  ) {}

  validate(raw: string, base?: URL): URL {
    let url: URL;
    let original = raw;
    try {
      url = base === undefined ? new URL(raw) : new URL(raw, base);
      if (base !== undefined) {
        original = new URL(raw, base).href;
      }
    } catch {
      throw new OutboundError(OutboundFailure.Blocked);
    }
    if (
      url.protocol !== 'http:'
      || url.hostname !== '127.0.0.1'
      || url.port !== String(this.port)
      || url.username !== ''
      || url.password !== ''
      || !original.startsWith(this.origin)
      || (original.length > this.origin.length && !'/?#'.includes(original[this.origin.length] ?? ''))
    ) {
      throw new OutboundError(OutboundFailure.Blocked);
    }
    return url;
  }
}

export class DefaultBlockedPolicy implements OutboundPolicy {
  readonly exactOrigin = false;

  validate(): URL {
    throw new OutboundError(OutboundFailure.Blocked);
  }
}

async function readResponseBody(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  truncate: boolean,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) {
      if (truncate) {
        const keep = maxBytes - (total - buf.length);
        if (keep > 0) {
          chunks.push(buf.subarray(0, keep));
        }
        break;
      }
      throw new OutboundError(OutboundFailure.TooLarge);
    }
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function headerText(value: string): string {
  const bytes = Buffer.from(value, 'latin1');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return bytes.toString('utf8');
  } catch {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      out += String.fromCharCode(bytes[i]!);
    }
    return out;
  }
}

function headerLines(headers: http.IncomingHttpHeaders): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    out[name.toLowerCase()] = Array.isArray(value) ? value : [value];
  }
  return out;
}

function encoded(headers: Record<string, string[]>): boolean {
  for (const line of headers['content-encoding'] ?? []) {
    for (const token of line.split(',')) {
      const trimmed = token.trim();
      if (trimmed !== '' && trimmed.toLowerCase() !== 'identity') {
        return true;
      }
    }
  }
  return false;
}

export class OutboundFetcher {
  private readonly permits = new OutboundPermits();

  constructor(readonly policy: OutboundPolicy) {}

  async get(raw: string, limits: FetchLimits, signal?: AbortSignal): Promise<FetchResponse> {
    const deadline = Date.now() + limits.timeoutMs;
    const releasePermit = await this.permits.acquire(limits.upload === true, limits.caller ?? '', deadline);
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      releasePermit();
    };
    try {
      if (this.policy.exactOrigin === true) {
        return await this.getConformance(raw, limits, release, deadline);
      }
      return await this.getNetwork(raw, limits, release, deadline, signal);
    } catch (error) {
      release();
      throw error;
    }
  }

  private async getConformance(
    raw: string,
    limits: FetchLimits,
    release: () => void,
    deadline: number,
  ): Promise<FetchResponse> {
    let redirects = 0;
    let current = raw;
    let base: URL | undefined;
    for (;;) {
      if (Date.now() > deadline) {
        throw new OutboundError(OutboundFailure.TimedOut);
      }
      const target = this.policy.validate(current, base);
      const path = `${target.pathname}${target.search}`;
      let response: Awaited<ReturnType<typeof rawGet>>;
      try {
        response = await rawGet(Number(target.port), path, limits.range);
      } catch (error) {
        if (error instanceof OutboundError) {
          throw error;
        }
        throw new OutboundError(OutboundFailure.Blocked);
      }
      const location = headerText(response.headers.location?.[0] ?? '');
      if (isRedirect(response.statusCode) && location !== '') {
        if (redirects >= limits.maxRedirects) {
          throw new OutboundError(OutboundFailure.TooManyRedirects);
        }
        if (limits.hop !== undefined && !limits.hop()) {
          throw new OutboundError(OutboundFailure.RateLimited);
        }
        base = target;
        try {
          current = new URL(location, target).href;
        } catch {
          throw new OutboundError(OutboundFailure.Blocked);
        }
        redirects += 1;
        continue;
      }
      const lengthHeader = response.headers['content-length']?.[0];
      const contentLength = lengthHeader === undefined ? undefined : Number.parseInt(lengthHeader, 10);
      let body: Buffer;
      try {
        body = await readBounded(
          response.body,
          Number.isFinite(contentLength) ? contentLength : undefined,
          response.headers,
          limits.maxBytes,
          limits.truncate === true,
        );
      } catch (error) {
        if (error instanceof OutboundError && error.failure === OutboundFailure.UnsupportedContentEncoding) {
          throw error;
        }
        throw error;
      }
      return {
        statusCode: response.statusCode,
        body: new Uint8Array(body),
        contentType: response.headers['content-type']?.[0]?.split(';')[0]?.trim() ?? '',
        finalUrl: target.href,
        headers: response.headers,
        redirects,
        release,
      };
    }
  }

  private async getNetwork(
    raw: string,
    limits: FetchLimits,
    release: () => void,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<FetchResponse> {
    let redirects = 0;
    let current = raw;
    let base: URL | undefined;
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason ?? new OutboundError(OutboundFailure.TimedOut);
      }
      if (Date.now() > deadline) {
        throw new OutboundError(OutboundFailure.TimedOut);
      }
      const target = this.policy.validate(current, base);
      const rangeHeader = limits.range === undefined
        ? undefined
        : limits.range.end < 0
          ? `bytes=${limits.range.start}-`
          : `bytes=${limits.range.start}-${limits.range.end}`;
      const headers: Record<string, string> = {
        Host: target.host,
        'User-Agent': USER_AGENT,
      };
      if (rangeHeader !== undefined) {
        headers.Range = rangeHeader;
      }
      const requester = target.protocol === 'https:' ? https : http;
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = requester.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers,
            family: 4,
            agent: false,
          },
          resolve,
        );
        req.on('error', reject);
        req.setTimeout(Math.max(0, deadline - Date.now()), () => {
          req.destroy();
          reject(new OutboundError(OutboundFailure.TimedOut));
        });
        req.end();
      });
      const headerMap = headerLines(response.headers);
      const location = headerText(response.headers.location ?? '');
      if (isRedirect(response.statusCode ?? 0) && location !== '') {
        response.resume();
        if (redirects >= limits.maxRedirects) {
          throw new OutboundError(OutboundFailure.TooManyRedirects);
        }
        if (limits.hop !== undefined && !limits.hop()) {
          throw new OutboundError(OutboundFailure.RateLimited);
        }
        base = target;
        try {
          current = new URL(location, target).href;
        } catch {
          throw new OutboundError(OutboundFailure.Blocked);
        }
        redirects += 1;
        continue;
      }
      const body = await readResponseBody(response, limits.maxBytes, limits.truncate === true);
      return {
        statusCode: response.statusCode ?? 0,
        body,
        contentType: String(response.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '',
        finalUrl: target.href,
        headers: headerMap,
        redirects,
        release,
      };
    }
  }
}

export function isOutboundFailure(error: unknown, failure: OutboundFailure): boolean {
  return error instanceof OutboundError && error.failure === failure;
}

export function upstreamExtent(response: FetchResponse): { start: number; total: number; ok: boolean } {
  const length = response.body.length;
  if (response.statusCode !== 206) {
    return { start: 0, total: length, ok: true };
  }
  const range = (response.headers['content-range']?.[0] ?? '').replace(/^bytes /, '');
  const [span, totalText] = range.split('/');
  const [startText, endText] = span?.split('-') ?? [];
  const start = Number.parseInt(startText ?? '', 10);
  const end = Number.parseInt(endText ?? '', 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start + 1 !== length) {
    return { start: 0, total: 0, ok: false };
  }
  if (totalText === '*') {
    return { start, total: -1, ok: true };
  }
  const total = Number.parseInt(totalText ?? '', 10);
  if (!Number.isFinite(total) || end >= total) {
    return { start: 0, total: 0, ok: false };
  }
  return { start, total, ok: true };
}

export { encoded };