import type { Body } from '../http/body.ts';
import { BodyError } from '../http/body.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { extension } from '../blob/key.ts';
import type { LocalStore } from '../blob/local.ts';
import { fileNameFromDisposition, sanitizeWireContentType } from './disposition.ts';
import { writePlain } from '../route/respond.ts';

const DEFAULT_MAX_UPLOAD = 33_554_432;
const MAX_MULTIPART_SECTIONS = 1000;

function boundaryFromContentType(value: string): string | undefined {
  const match = /boundary=([^;\s]+|"[^"]+")/i.exec(value);
  if (!match) {
    return undefined;
  }
  let raw = match[1] ?? '';
  if (raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1);
  }
  return raw.length > 0 ? raw : undefined;
}

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
    return undefined;
  }
  let at = start + delimiter.length;
  if (text[at] === 0x0d && text[at + 1] === 0x0a) {
    at += 2;
  } else if (text[at] === 0x0a) {
    at += 1;
  }
  let sections = 0;
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
      return undefined;
    }
    const headers = text.subarray(at, headerEnd).toString('latin1');
    const bodyStart = headerEnd + 4;
    const next = text.indexOf(`\r\n${delimiter}`, bodyStart);
    if (next < 0) {
      return undefined;
    }
    const part = text.subarray(bodyStart, next);
    const disposition = headerValue(headers, 'content-disposition');
    const fileName = fileNameFromDisposition(disposition);
    if (fileName !== undefined && fileName.length > 0) {
      const mimeType = sanitizeWireContentType(headerValue(headers, 'content-type'));
      return { fileName, content: new Uint8Array(part), mimeType };
    }
    at = next + 2 + delimiter.length;
    if (text[at] === 0x0d && text[at + 1] === 0x0a) {
      at += 2;
    }
  }
  return undefined;
}

export async function uploadHandler(
  store: LocalStore,
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
    url = await store.put(extension(parsed.fileName), Buffer.from(parsed.content));
  } catch {
    await writePlain(request, response, 502, 'upload failed\n');
    return;
  }
  const envelope: Record<string, string | number> = {
    url,
    fileName: parsed.fileName,
    size: parsed.content.length,
  };
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