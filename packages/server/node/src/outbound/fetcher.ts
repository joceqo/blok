import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { rawGet } from './raw-fetch.ts';

export const USER_AGENT = 'blok-server (+https://blokeditor.com)';

export enum OutboundFailure {
  Blocked = 'Blocked',
  TooLarge = 'TooLarge',
  TimedOut = 'TimedOut',
  TooManyRedirects = 'TooManyRedirects',
  RateLimited = 'RateLimited',
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
  release(): void;
}

export interface OutboundPolicy {
  validate(raw: string, base?: URL): URL;
}

export class ExactOriginPolicy implements OutboundPolicy {
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
  constructor(readonly policy: OutboundPolicy) {}

  async get(raw: string, limits: FetchLimits, signal?: AbortSignal): Promise<FetchResponse> {
    if (this.policy instanceof ExactOriginPolicy) {
      return this.getConformance(raw, limits, signal);
    }
    const deadline = Date.now() + limits.timeoutMs;
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
      const location = response.headers.location ?? '';
      if (isRedirect(response.statusCode ?? 0) && location !== '') {
        response.resume();
        if (redirects >= limits.maxRedirects) {
          throw new OutboundError(OutboundFailure.TooManyRedirects);
        }
        if (limits.hop !== undefined && !limits.hop()) {
          throw new OutboundError(OutboundFailure.RateLimited);
        }
        base = target;
        current = location;
        redirects += 1;
        continue;
      }
      const body = await readResponseBody(response, limits.maxBytes, limits.truncate === true);
      const released = { done: false };
      return {
        statusCode: response.statusCode ?? 0,
        body,
        contentType: String(response.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '',
        finalUrl: target.href,
        headers: headerMap,
        release() {
          released.done = true;
        },
      };
    }
  }

  private async getConformance(raw: string, limits: FetchLimits, signal?: AbortSignal): Promise<FetchResponse> {
    if (signal?.aborted) {
      throw signal.reason ?? new OutboundError(OutboundFailure.TimedOut);
    }
    let redirects = 0;
    let current = raw;
    let base: URL | undefined;
    for (;;) {
      const target = this.policy.validate(current, base);
      const path = `${target.pathname}${target.search}`;
      const response = await rawGet(Number(target.port), path, limits.range);
      const location = response.headers.location?.[0] ?? '';
      if (isRedirect(response.statusCode) && location !== '') {
        if (redirects >= limits.maxRedirects) {
          throw new OutboundError(OutboundFailure.TooManyRedirects);
        }
        if (limits.hop !== undefined && !limits.hop()) {
          throw new OutboundError(OutboundFailure.RateLimited);
        }
        base = target;
        current = new URL(location, target).href;
        redirects += 1;
        continue;
      }
      if (response.body.length > limits.maxBytes && !limits.truncate) {
        throw new OutboundError(OutboundFailure.TooLarge);
      }
      const body = limits.truncate
        ? response.body.subarray(0, limits.maxBytes)
        : response.body;
      return {
        statusCode: response.statusCode,
        body: new Uint8Array(body),
        contentType: response.headers['content-type']?.[0]?.split(';')[0]?.trim() ?? '',
        finalUrl: target.href,
        headers: response.headers,
        release() {},
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