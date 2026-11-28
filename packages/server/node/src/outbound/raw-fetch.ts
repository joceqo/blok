import net from 'node:net';

import type { ByteRange } from './fetcher.ts';
import { OutboundFailure, OutboundError, USER_AGENT } from './fetcher.ts';

const MAX_RESPONSE_HEAD = 64 << 10;

export interface RawResponse {
  statusCode: number;
  headers: Record<string, string[]>;
  body: Buffer;
}

export interface RawGet {
  promise: Promise<RawResponse>;
  cancel(): Promise<void>;
}

function parseHeaders(block: string): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  for (const line of block.split('\r\n')) {
    if (line === '') {
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = [...(headers[name] ?? []), value];
  }
  return headers;
}

function readHead(buffer: Buffer): { statusCode: number; headersEnd: number; headers: Record<string, string[]> } {
  let end = -1;
  const limit = Math.min(buffer.length, MAX_RESPONSE_HEAD + 4);
  for (let i = 0; i < limit - 3; i += 1) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    if (buffer.length > MAX_RESPONSE_HEAD) {
      throw new OutboundError(OutboundFailure.TooLarge);
    }
    throw new Error('incomplete head');
  }
  const head = buffer.subarray(0, end).toString('latin1');
  const lines = head.split('\r\n');
  const status = Number.parseInt((lines[0]?.split(' ')[1] ?? ''), 10);
  if (!Number.isFinite(status)) {
    throw new Error('malformed status');
  }
  return { statusCode: status, headersEnd: end + 4, headers: parseHeaders(lines.slice(1).join('\r\n')) };
}

function isChunked(headers: Record<string, string[]>): boolean {
  return (headers['transfer-encoding'] ?? []).some((v) => v.toLowerCase().includes('chunked'));
}

function readBody(buffer: Buffer, headersEnd: number, headers: Record<string, string[]>): Buffer {
  const lengthText = headers['content-length']?.[0];
  if (lengthText !== undefined) {
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isFinite(length) || length < 0) {
      return buffer.subarray(headersEnd);
    }
    return buffer.subarray(headersEnd, headersEnd + length);
  }
  if (isChunked(headers)) {
    return decodeChunked(buffer.subarray(headersEnd));
  }
  return buffer.subarray(headersEnd);
}

/**
 * Whether the framing says the whole body has arrived. Without it the fetch
 * would have to wait for the origin to close, which costs a connection per
 * fetch and — because a half-closed request makes Node's own server abort a
 * reply it has not written yet — frees the fetch's outbound permit while the
 * origin still holds the request.
 */
function bodyComplete(buffer: Buffer, headersEnd: number, headers: Record<string, string[]>): boolean {
  const lengthText = headers['content-length']?.[0];
  if (lengthText !== undefined) {
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isFinite(length) || length < 0) {
      return false;
    }
    return buffer.length - headersEnd >= length;
  }
  if (isChunked(headers)) {
    return chunkedComplete(buffer.subarray(headersEnd));
  }
  return false;
}

/** Head plus body under Content-Length framing, or undefined under any other. */
function contentLengthTotal(headersEnd: number, headers: Record<string, string[]>): number | undefined {
  const lengthText = headers['content-length']?.[0];
  if (lengthText === undefined) {
    return undefined;
  }
  const length = Number.parseInt(lengthText, 10);
  return Number.isFinite(length) && length >= 0 ? headersEnd + length : undefined;
}

/** True once the terminal zero-size chunk line is in the buffer. */
function chunkedComplete(data: Buffer): boolean {
  let at = 0;
  while (at < data.length) {
    const lineEnd = data.indexOf(0x0a, at);
    if (lineEnd < 0) {
      return false;
    }
    const line = data.subarray(at, lineEnd).toString('latin1').trim();
    const size = Number.parseInt(line.split(';')[0] ?? '', 16);
    if (!Number.isFinite(size)) {
      return false;
    }
    at = lineEnd + 1;
    if (size === 0) {
      return true;
    }
    at += size + 2;
  }
  return false;
}

function decodeChunked(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let at = 0;
  while (at < data.length) {
    const lineEnd = data.indexOf(0x0a, at);
    if (lineEnd < 0) {
      break;
    }
    const line = data.subarray(at, lineEnd).toString('latin1').trim();
    const size = Number.parseInt(line.split(';')[0] ?? '', 16);
    if (!Number.isFinite(size)) {
      break;
    }
    at = lineEnd + 1;
    if (size === 0) {
      break;
    }
    chunks.push(data.subarray(at, at + size));
    at += size + 2;
  }
  return Buffer.concat(chunks);
}

export function rawGet(port: number, path: string, range?: ByteRange, deadlineMs?: number): RawGet {
  let request = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUser-Agent: ${USER_AGENT}\r\n`;
  if (range !== undefined) {
    const value = range.end < 0 ? `bytes=${range.start}-` : `bytes=${range.start}-${range.end}`;
    request += `Range: ${value}\r\n`;
  }
  request += '\r\n';
  const socket = net.createConnection({ host: '127.0.0.1', port });
  let settled = false;
  const promise = new Promise<RawResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let buffered = 0;
    let timer: NodeJS.Timeout | undefined;
    const settle = (answer: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      answer();
    };
    // Total message bytes, once a Content-Length head has said so. Checking it
    // against the running count keeps a long download off the quadratic path
    // of joining every chunk again on every chunk.
    let required: number | undefined;
    // `ended` is the connection-close framing: whatever arrived is the body.
    const take = (ended: boolean): void => {
      if (!ended && required !== undefined && buffered < required) {
        return;
      }
      const buffer = Buffer.concat(chunks);
      let parsed: ReturnType<typeof readHead>;
      try {
        parsed = readHead(buffer);
      } catch (error) {
        if (ended || error instanceof OutboundError) {
          settle(() => reject(error));
        }
        return;
      }
      required = contentLengthTotal(parsed.headersEnd, parsed.headers);
      if (!ended && !bodyComplete(buffer, parsed.headersEnd, parsed.headers)) {
        return;
      }
      const body = readBody(buffer, parsed.headersEnd, parsed.headers);
      settle(() => resolve({ statusCode: parsed.statusCode, headers: parsed.headers, body }));
    };
    if (deadlineMs !== undefined) {
      timer = setTimeout(
        () => settle(() => reject(new OutboundError(OutboundFailure.TimedOut))),
        Math.max(0, deadlineMs - Date.now()),
      );
    }
    socket.on('error', (error) => settle(() => reject(error)));
    socket.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;

      chunks.push(bytes);
      buffered += bytes.length;
      if (buffered > MAX_RESPONSE_HEAD + (8 << 20)) {
        settle(() => reject(new OutboundError(OutboundFailure.TooLarge)));
        return;
      }
      take(false);
    });
    socket.on('end', () => take(true));
    socket.write(request);
  });
  return {
    promise,
    cancel(): Promise<void> {
      if (settled) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const onClose = (): void => {
          socket.off('close', onClose);
          resolve();
        };
        socket.once('close', onClose);
        socket.destroy();
      });
    },
  };
}