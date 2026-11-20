import net from 'node:net';

import type { ByteRange } from './fetcher.ts';
import { OutboundFailure, OutboundError, USER_AGENT } from './fetcher.ts';

const MAX_RESPONSE_HEAD = 64 << 10;

export interface RawResponse {
  statusCode: number;
  headers: Record<string, string[]>;
  body: Buffer;
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

function readBody(buffer: Buffer, headersEnd: number, headers: Record<string, string[]>): Buffer {
  const lengthText = headers['content-length']?.[0];
  if (lengthText !== undefined) {
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isFinite(length) || length < 0) {
      return buffer.subarray(headersEnd);
    }
    return buffer.subarray(headersEnd, headersEnd + length);
  }
  if ((headers['transfer-encoding'] ?? []).some((v) => v.toLowerCase().includes('chunked'))) {
    return decodeChunked(buffer.subarray(headersEnd));
  }
  return buffer.subarray(headersEnd);
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

export function rawGet(port: number, path: string, range?: ByteRange): Promise<RawResponse> {
  let request = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUser-Agent: ${USER_AGENT}\r\n`;
  if (range !== undefined) {
    const value = range.end < 0 ? `bytes=${range.start}-` : `bytes=${range.start}-${range.end}`;
    request += `Range: ${value}\r\n`;
  }
  request += 'Connection: close\r\n\r\n';
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > MAX_RESPONSE_HEAD + (8 << 20)) {
        socket.destroy();
        reject(new OutboundError(OutboundFailure.TooLarge));
      }
    });
    socket.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const parsed = readHead(buffer);
        const body = readBody(buffer, parsed.headersEnd, parsed.headers);
        resolve({ statusCode: parsed.statusCode, headers: parsed.headers, body });
      } catch (error) {
        reject(error);
      }
    });
    socket.end(request);
  });
}