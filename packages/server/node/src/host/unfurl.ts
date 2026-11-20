import { absoluteUri } from '../dotnet/absolute-uri.ts';
import { queryFirst } from '../dotnet/query.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { browserUrl } from '../outbound/browser-url.ts';
import { fetchCaller, hopBudget } from './guard.ts';
import type { HostAppOptions } from './options.ts';
import { parseUnfurlMetadata } from '../unfurl/parse.ts';

async function writeJson(request: Request, response: ResponseWriter, status: number, body: string): Promise<void> {
  response.setStatus(status);
  response.headersMut().set('Content-Type', 'application/json');
  await response.start(status);
  if (request.method() !== 'HEAD') {
    await response.write(new TextEncoder().encode(body));
  }
}

export async function unfurlHandler(
  options: HostAppOptions,
  request: Request,
  response: ResponseWriter,
): Promise<void> {
  const rawQuery = request.query();
  const target = queryFirst(rawQuery.startsWith('?') ? rawQuery : `?${rawQuery}`, 'url');
  if (target === '') {
    await writeJson(request, response, 400, '{"success":0}\n');
    return;
  }
  try {
    const fetched = await options.fetcher.get(target, {
      timeoutMs: 10_000,
      maxBytes: 2 << 20,
      maxRedirects: 5,
      hop: hopBudget(options, request),
      caller: fetchCaller(options, request),
    });
    try {
      if (fetched.statusCode < 200 || fetched.statusCode > 299) {
        await writeJson(request, response, 200, '{"success":0}\n');
        return;
      }
      const meta = parseUnfurlMetadata(fetched.body, fetched.finalUrl);
      const image = browserUrl(fetched.finalUrl, meta.image);
      const favicon = browserUrl(fetched.finalUrl, meta.favicon);
      const metaRecord: Record<string, unknown> = {
        image: image === '' ? {} : { url: image },
      };
      if (meta.title !== '') {
        metaRecord.title = meta.title;
      }
      if (meta.description !== '') {
        metaRecord.description = meta.description;
      }
      if (favicon !== '') {
        metaRecord.favicon = favicon;
      }
      if (meta.domain !== '') {
        metaRecord.domain = meta.domain;
      }
      const payload = `${JSON.stringify({ success: 1, link: absoluteUri(fetched.finalUrl), meta: metaRecord })}\n`;
      await writeJson(request, response, 200, payload);
    } finally {
      fetched.release();
    }
  } catch {
    if (!request.isCancelled()) {
      await writeJson(request, response, 200, '{"success":0}\n');
    }
  }
}