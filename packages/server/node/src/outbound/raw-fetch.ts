import net from 'node:net';

import type { ByteRange } from './fetcher.ts';
import { USER_AGENT } from './fetcher.ts';

interface RawResponse {
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

function readHeaders(buffer: Buffer): { headersEnd: number; statusCode: number; headers: Record<string, string[]> } | undefined {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) {
    return undefined;
  }
  const head = buffer.subarray(0, end).toString('latin1');
  const lines = head.split('\r\n');
  const status = Number.parseInt((lines[0]?.split(' ')[1] ?? ''), 10);
  if (!Number.isFinite(status)) {
    return undefined;
  }
  return { headersEnd: end + 4, statusCode: status, headers: parseHeaders(lines.slice(1).join('\r\n')) };
}

export function rawGet(port: number, path: string, range?: ByteRange): Promise<RawResponse> {
  let request = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUser-Agent: ${USER_AGENT}\r\n`;
  if (range !== undefined) {
    const value = range.end < 0 ? `bytes=${range.start}-` : `bytes=${range.start}-${range.end}`;
    request += `Range: ${value}\r\n`;
  }
  request += '\r\n';
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.on('error', reject);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const parsed = readHeaders(buffer);
      if (parsed === undefined) {
        reject(new Error('malformed response'));
        return;
      }
      const lengthText = parsed.headers['content-length']?.[0];
      const length = lengthText === undefined ? buffer.length - parsed.headersEnd : Number.parseInt(lengthText, 10);
      resolve({
        statusCode: parsed.statusCode,
        headers: parsed.headers,
        body: buffer.subarray(parsed.headersEnd, parsed.headersEnd + length),
      });
    });
    socket.end(request);
  });
}