import { BodyError } from '../http/body.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { extension } from '../blob/key.ts';
import type { LocalStore } from '../blob/local.ts';
import { isJsonContentType, sanitizeWire } from '../mediatype/index.ts';
import { readEnvelopeJson } from './envelope.ts';
import { hopBudget } from './guard.ts';
import type { HostAppOptions } from './options.ts';
import { writePlain } from '../route/respond.ts';
import { unescapeDataString } from '../dotnet/unescape.ts';

function sanitizeFileName(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) {
    name = name.slice(slash + 1);
  }
  if (name === '.' || name === '..' || name.length > 255) {
    return '';
  }
  return name;
}

function nameFromUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    return sanitizeFileName(unescapeDataString(url.pathname.split('/').pop() ?? ''));
  } catch {
    return '';
  }
}

async function readBody(request: Request): Promise<Uint8Array | undefined> {
  const body = request.takeBody();
  if (!body) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  try {
    await body.readToEnd(chunks);
  } catch (error) {
    if (error === BodyError.TooLarge) {
      throw error;
    }
    return undefined;
  }
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    data.set(part, at);
    at += part.length;
  }
  return data;
}

function uploadJson(
  request: Request,
  response: ResponseWriter,
  envelope: Record<string, string | number>,
): Promise<void> {
  response.headersMut().set('Content-Type', 'application/json');
  const payload = JSON.stringify(envelope) + '\n';
  return response.start(200).then(async () => {
    if (request.method() !== 'HEAD') {
      await response.write(new TextEncoder().encode(payload));
    }
  });
}

export async function uploadByUrlHandler(
  store: LocalStore,
  options: HostAppOptions,
  request: Request,
  response: ResponseWriter,
): Promise<void> {
  const contentType = request.headers().get('content-type') ?? '';
  if (!isJsonContentType(contentType)) {
    await writePlain(request, response, 415, 'expected application/json\n');
    return;
  }
  let data: Uint8Array | undefined;
  try {
    data = await readBody(request);
  } catch (error) {
    if (error === BodyError.TooLarge) {
      await writePlain(request, response, 413, 'file too large\n');
      return;
    }
    await writePlain(request, response, 400, 'expected {"url": "..."}\n');
    return;
  }
  if (data === undefined) {
    await writePlain(request, response, 400, 'expected {"url": "..."}\n');
    return;
  }
  const target = readEnvelopeJson(data);
  if (target === undefined) {
    await writePlain(request, response, 400, 'expected {"url": "..."}\n');
    return;
  }
  let fetched;
  try {
    fetched = await options.fetcher.get(target, {
      timeoutMs: 120_000,
      maxBytes: options.maxUploadBytes,
      maxRedirects: 5,
      hop: hopBudget(options, request),
      upload: true,
    });
  } catch {
    if (!request.isCancelled()) {
      await writePlain(request, response, 400, 'the URL could not be fetched\n');
    }
    return;
  }
  try {
    if (fetched.statusCode < 200 || fetched.statusCode > 299) {
      await writePlain(request, response, 400, 'the URL could not be fetched\n');
      return;
    }
    const fileName = nameFromUrl(fetched.finalUrl);
    const mimeType = sanitizeWire(fetched.contentType);
    let url: string;
    try {
      url = await store.put(extension(fileName), Buffer.from(fetched.body));
    } catch {
      if (!request.isCancelled()) {
        await writePlain(request, response, 502, 'upload failed\n');
      }
      return;
    }
    const envelope: Record<string, string | number> = { url, fileName, size: fetched.body.length };
    if (mimeType !== '') {
      envelope.mimeType = mimeType;
    }
    response.setStatus(200);
    await uploadJson(request, response, envelope);
  } finally {
    fetched.release();
  }
}