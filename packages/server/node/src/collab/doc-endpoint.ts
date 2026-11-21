import http from 'node:http';
import https from 'node:https';

import { trimChars } from '../http/headers.ts';

export const VERSION_HEADER = 'Blok-Doc-Version';

const DEFAULT_MAX_RESPONSE_BYTES = 64 << 20;
const ERROR_BODY_PREFIX_BYTES = 512;

export class DocEndpointError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 0) {
    super(message);
    this.name = 'DocEndpointError';
    this.statusCode = statusCode;
  }
}

export interface LoadedDocument {
  data: unknown;
  version: string | undefined;
}

export interface DocEndpointOptions {
  endpoint: string;
  authorization: string;
  requestTimeoutMs?: number;
}

/** Tab, printable ASCII and U+0080..U+00FF; other runes refuse the header. */
export function sendableHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length;) {
    const code = value.charCodeAt(i);
    if (code === 0x09) {
      i += 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        if (cp > 0xff) {
          return false;
        }
        i += 2;
        continue;
      }
    }
    if (code === 0x7f || code < 0x20 || code > 0xff) {
      return false;
    }
    i += 1;
  }
  return true;
}

function headerValue(value: string): string {
  return trimChars(value, ' \t');
}

function urlFor(endpoint: string, docId: string): string {
  const base = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  const prefix = base.pathname.replace(/\/$/, '');
  const path = `${prefix}/${encodeURIComponent(docId)}`;
  return `${base.protocol}//${base.host}${path}`;
}

function readErrorPrefix(body: Buffer): string {
  if (body.length === 0) {
    return '';
  }
  const slice = body.subarray(0, Math.min(body.length, ERROR_BODY_PREFIX_BYTES));
  const text = slice.toString('utf8').replace(/\s+$/, '');
  return text === '' ? '' : `: ${text}`;
}

async function readResponseBody(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new DocEndpointError(`collab: the doc endpoint answer is too large.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function request(
  options: DocEndpointOptions,
  method: string,
  url: string,
  extraHeaders: Array<[string, string]>,
  body?: Buffer,
): Promise<{ status: number; body: Buffer }> {
  const auth = options.authorization;
  if (auth !== '' && !sendableHeaderValue(auth)) {
    throw new DocEndpointError(
      'collab: the doc endpoint Authorization value cannot be sent as a header (a stray newline?).',
    );
  }

  const headers: Array<[string, string]> = [
    ['Accept', 'application/json'],
    ['User-Agent', ''],
  ];
  if (auth !== '') {
    headers.push(['Authorization', headerValue(auth)]);
  }
  for (const [name, value] of extraHeaders) {
    if (name === VERSION_HEADER) {
      if (!sendableHeaderValue(value)) {
        throw new DocEndpointError('collab: the doc endpoint version cannot be sent as a header.');
      }
      headers.push([name, headerValue(value)]);
    } else {
      headers.push([name, value]);
    }
  }
  if (body !== undefined) {
    headers.push(['Content-Type', 'application/json; charset=utf-8']);
    headers.push(['Content-Length', String(body.length)]);
  }

  const parsed = new URL(url);
  const requester = parsed.protocol === 'https:' ? https : http;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const req = requester.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port === '' ? undefined : parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
      },
      async (res) => {
        try {
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 299) {
            const prefixBody = await readResponseBody(res, ERROR_BODY_PREFIX_BYTES);
            const prefix = readErrorPrefix(prefixBody);
            reject(new DocEndpointError(
              `collab: the doc endpoint ${method} returned ${status}${prefix}`,
              status,
            ));
            return;
          }
          const answer = await readResponseBody(res, DEFAULT_MAX_RESPONSE_BYTES);
          resolve({ status, body: answer });
        } catch (error) {
          reject(error);
        }
      },
    );
    for (const [name, value] of headers) {
      req.setHeader(name, value);
    }
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new DocEndpointError(`collab: the doc endpoint ${method} timed out after ${timeoutMs / 1000}s.`));
    });
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function parseLoaded(body: Buffer): LoadedDocument {
  let root: unknown;
  try {
    root = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new DocEndpointError('collab: the doc endpoint did not answer with JSON.');
  }
  if (root === null) {
    return { data: null, version: undefined };
  }
  if (typeof root !== 'object' || Array.isArray(root)) {
    throw new DocEndpointError('collab: the doc endpoint answered with JSON that is not an object.');
  }
  const record = root as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'data')) {
    return { data: record, version: undefined };
  }
  const data = record.data;
  if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
    throw new DocEndpointError('collab: the doc endpoint envelope carries data that is not an object.');
  }
  const version = record.version;
  if (version !== undefined && typeof version !== 'string') {
    throw new DocEndpointError('collab: the doc endpoint envelope carries a version that is not a string.');
  }
  return { data, version };
}

export class DocEndpointClient {
  constructor(readonly options: DocEndpointOptions) {}

  async load(docId: string): Promise<LoadedDocument> {
    const url = urlFor(this.options.endpoint, docId);
    const { body } = await request(this.options, 'GET', url, []);
    return parseLoaded(body);
  }

  async save(docId: string, outputData: unknown, version: string | undefined): Promise<void> {
    const url = urlFor(this.options.endpoint, docId);
    let payload: Buffer;
    try {
      payload = Buffer.from(JSON.stringify(outputData), 'utf8');
    } catch {
      throw new DocEndpointError('collab: the document could not be serialized.');
    }
    const headers: Array<[string, string]> = [];
    if (version !== undefined) {
      headers.push([VERSION_HEADER, version]);
    }
    await request(this.options, 'PUT', url, headers, payload);
  }
}