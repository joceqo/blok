import type { Body } from '../http/body.ts';
import { BodyError } from '../http/body.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { extension } from '../blob/key.ts';
import type { BlobStore } from '../blob/store.ts';
import { boundaryFromContentType } from '../mediatype/index.ts';
import { fileNameFromDisposition, sanitizeWireContentType } from './disposition.ts';
import { writePlain } from '../route/respond.ts';

const DEFAULT_MAX_UPLOAD = 33_554_432;
const MAX_MULTIPART_SECTIONS = 1000;

async function readAll(body: Body): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  try {
    await body.readToEnd(chunks);
  } catch (error) {
    if (error === BodyError.TooLarge) {
      throw error;
    }
    throw BodyError.Malformed;
  }
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function hexDigit(c: number): number | undefined {
  if (c >= 0x30 && c <= 0x39) {
    return c - 0x30;
  }
  if (c >= 0x41 && c <= 0x46) {
    return c - 0x41 + 10;
  }
  if (c >= 0x61 && c <= 0x66) {
    return c - 0x61 + 10;
  }
  return undefined;
}

function decodeQuotedPrintable(data: Uint8Array): Uint8Array | undefined {
  const decoded: number[] = [];
  const pushLine = (raw: Buffer, hasLf: boolean, hasCr: boolean): boolean => {
    if (raw.length > 4096) {
      return false;
    }
    let content = raw.length;
    while (content > 0 && (raw[content - 1] === 0x0a || raw[content - 1] === 0x0d || raw[content - 1] === 0x20 || raw[content - 1] === 0x09)) {
      content -= 1;
    }
    let appendEnding = hasLf;
    let body = raw.subarray(0, content);
    if (body.length > 0 && body[body.length - 1] === 0x3d) {
      appendEnding = false;
      body = body.subarray(0, body.length - 1);
      let suffix = body.length;
      while (suffix < raw.length && (raw[suffix] === 0x20 || raw[suffix] === 0x09)) {
        suffix += 1;
      }
      const startsLineEnding = suffix < raw.length
        && (raw[suffix] === 0x0a || (raw[suffix] === 0x0d && suffix + 1 < raw.length && raw[suffix + 1] === 0x0a));
      if (!startsLineEnding) {
        return false;
      }
    }
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i]!;
      if (c === 0x3d && i + 2 < body.length) {
        const hi = hexDigit(body[i + 1]!);
        const lo = hexDigit(body[i + 2]!);
        if (hi !== undefined && lo !== undefined) {
          decoded.push(hi << 4 | lo);
          i += 2;
          continue;
        }
      }
      if (c === 0x3d || (c !== 0x09 && c !== 0x0d && c !== 0x0a && c < 0x80 && (c < 0x20 || c > 0x7e))) {
        return false;
      }
      decoded.push(c);
    }
    if (appendEnding) {
      if (hasCr) {
        decoded.push(0x0d);
      }
      decoded.push(0x0a);
    }
    return true;
  };
  const input = Buffer.from(data);
  let start = 0;
  for (let i = 0; i <= input.length; i += 1) {
    if (i < input.length && input[i] !== 0x0a) {
      continue;
    }
    const hasLf = i < input.length;
    const end = hasLf && i > start && input[i - 1] === 0x0d ? i - 1 : i;
    const hasCr = hasLf && i > start && input[i - 1] === 0x0d;
    const line = input.subarray(start, end);
    if (!pushLine(line, hasLf, hasCr)) {
      return undefined;
    }
    start = i + 1;
  }
  return Uint8Array.from(decoded);
}

function headerValue(headers: string, name: string): string {
  const needle = name.toLowerCase();
  for (const line of headers.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    if (line.slice(0, colon).trim().toLowerCase() === needle) {
      return line.slice(colon + 1).trim();
    }
  }
  return '';
}

function parseMultipart(
  data: Uint8Array,
  boundary: string,
): { fileName: string; content: Uint8Array; mimeType: string } | 'malformed' | undefined {
  const text = Buffer.from(data);
  const delimiter = `--${boundary}`;
  const end = `--${boundary}--`;
  const start = text.indexOf(delimiter);
  if (start < 0) {
    return 'malformed';
  }
  let at = start + delimiter.length;
  if (text[at] === 0x0d && text[at + 1] === 0x0a) {
    at += 2;
  } else if (text[at] === 0x0a) {
    at += 1;
  }
  let sections = 0;
  let filePart: { fileName: string; content: Uint8Array; mimeType: string } | undefined;
  for (;;) {
    if (text.subarray(at, at + end.length).equals(Buffer.from(end))) {
      break;
    }
    sections += 1;
    if (sections > MAX_MULTIPART_SECTIONS) {
      return 'malformed';
    }
    const headerEnd = text.indexOf('\r\n\r\n', at);
    if (headerEnd < 0) {
      return 'malformed';
    }
    const headers = text.subarray(at, headerEnd).toString('latin1');
    const bodyStart = headerEnd + 4;
    const next = text.indexOf(`\r\n${delimiter}`, bodyStart);
    if (next < 0) {
      return 'malformed';
    }
    const afterDelimiter = next + 2 + delimiter.length;
    const isClose = text[afterDelimiter] === 0x2d && text[afterDelimiter + 1] === 0x2d;
    const part = text.subarray(bodyStart, next);
    const encoding = headerValue(headers, 'content-transfer-encoding').toLowerCase();
    let content = new Uint8Array(part);
    if (encoding === 'quoted-printable') {
      const decoded = decodeQuotedPrintable(content);
      if (decoded === undefined) {
        return 'malformed';
      }
      content = decoded;
    }
    const disposition = headerValue(headers, 'content-disposition');
    const fileName = fileNameFromDisposition(disposition);
    if (fileName !== undefined) {
      const mimeType = sanitizeWireContentType(headerValue(headers, 'content-type'));
      filePart = { fileName, content, mimeType };
    }
    if (isClose) {
      break;
    }
    at = afterDelimiter;
    if (text[at] === 0x0d && text[at + 1] === 0x0a) {
      at += 2;
    }
  }
  return filePart;
}

export async function uploadHandler(
  store: BlobStore,
  maxUploadBytes: number,
  request: Request,
  response: ResponseWriter,
): Promise<void> {
  request.setBodyLimit(maxUploadBytes);
  const body = request.takeBody();
  if (!body) {
    await writePlain(request, response, 400, 'malformed upload\n');
    return;
  }
  const contentType = request.headers().get('content-type') ?? '';
  const boundary = boundaryFromContentType(contentType);
  if (boundary === undefined) {
    await writePlain(request, response, 400, 'malformed upload\n');
    return;
  }
  let data: Uint8Array;
  try {
    data = await readAll(body);
  } catch (error) {
    if (error === BodyError.TooLarge) {
      await writePlain(request, response, 413, 'file too large\n');
      return;
    }
    await writePlain(request, response, 400, 'malformed upload\n');
    return;
  }
  const parsed = parseMultipart(data, boundary);
  if (parsed === 'malformed') {
    await writePlain(request, response, 400, 'malformed upload\n');
    return;
  }
  if (!parsed) {
    await writePlain(request, response, 400, 'missing file field\n');
    return;
  }
  let url: string;
  try {
    url = await store.put(extension(parsed.fileName), Buffer.from(parsed.content), parsed.mimeType);
  } catch {
    await writePlain(request, response, 502, 'upload failed\n');
    return;
  }
  const envelope: Record<string, string | number> = { url };
  if (parsed.fileName !== '') {
    envelope.fileName = parsed.fileName;
  }
  if (parsed.content.length !== 0) {
    envelope.size = parsed.content.length;
  }
  if (parsed.mimeType !== '') {
    envelope.mimeType = parsed.mimeType;
  }
  const payload = JSON.stringify(envelope) + '\n';
  response.headersMut().set('Content-Type', 'application/json');
  await response.start(200);
  if (request.method() !== 'HEAD') {
    await response.write(new TextEncoder().encode(payload));
  }
}

export function defaultMaxUpload(fromFlag: number | undefined): number {
  return fromFlag ?? DEFAULT_MAX_UPLOAD;
}