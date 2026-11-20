import { BodyError } from '../http/body.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { ErrForeign } from '../blob/key.ts';
import type { LocalStore } from '../blob/local.ts';
import { isJsonContentType } from '../mediatype/index.ts';
import { readEnvelopeJson } from './envelope.ts';
import { writePlain } from '../route/respond.ts';

export async function deleteHandler(
  store: LocalStore,
  request: Request,
  response: ResponseWriter,
): Promise<void> {
  const contentType = request.headers().get('content-type') ?? '';
  if (!isJsonContentType(contentType)) {
    await writePlain(request, response, 415, 'expected application/json\n');
    return;
  }
  const body = request.takeBody();
  if (!body) {
    await writePlain(request, response, 400, 'expected {"url": "..."}\n');
    return;
  }
  const chunks: Uint8Array[] = [];
  try {
    await body.readToEnd(chunks);
  } catch (error) {
    if (error === BodyError.TooLarge) {
      await writePlain(request, response, 413, 'file too large\n');
      return;
    }
    await writePlain(request, response, 400, 'expected {"url": "..."}\n');
    return;
  }
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    data.set(part, at);
    at += part.length;
  }
  const target = readEnvelopeJson(data);
  if (target === undefined) {
    await writePlain(request, response, 400, 'expected {"url": "..."}\n');
    return;
  }
  try {
    await store.deleteByUrl(target);
  } catch (error) {
    if (error === ErrForeign) {
      await writePlain(request, response, 404, 'not found\n');
      return;
    }
    await writePlain(request, response, 502, 'delete failed\n');
    return;
  }
  response.headersMut().set('Content-Type', 'application/json');
  await response.start(200);
  if (request.method() !== 'HEAD') {
    await response.write(new TextEncoder().encode('{"success":1}\n'));
  }
}