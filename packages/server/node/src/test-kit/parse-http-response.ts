export interface ParsedHttpResponse {
  status: number;
  headers: Record<string, string[]>;
  body: string;
}

function decodeChunked(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) {
      break;
    }
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('latin1'), 16);
    if (!Number.isFinite(size) || size === 0) {
      break;
    }
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/** Parses one in-memory HTTP/1.1 response (including chunked bodies). */
export function parseHttpResponse(raw: Buffer): ParsedHttpResponse {
  const headEnd = raw.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    throw new Error('incomplete HTTP response');
  }
  const head = raw.subarray(0, headEnd).toString('latin1');
  const lines = head.split('\r\n');
  const statusLine = lines[0] ?? '';
  const status = Number.parseInt(statusLine.split(' ')[1] ?? '0', 10);
  const headers: Record<string, string[]> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
  headers[name] ??= [];
    headers[name]?.push(value);
  }
  let bodyBuf = raw.subarray(headEnd + 4);
  const transfer = (headers['transfer-encoding'] ?? []).join(',');
  if (transfer.toLowerCase().includes('chunked')) {
    bodyBuf = decodeChunked(bodyBuf);
  }
  return {
    status,
    headers,
    body: bodyBuf.toString('utf8'),
  };
}