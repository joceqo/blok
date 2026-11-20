import { queryFirst } from '../dotnet/query.ts';
import { equalsOrdinalIgnoreCase } from '../dotnet/ordinal.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { chooseEmbedder } from '../framecheck/embedder.ts';
import { appendOembedJson, oembedEmpty, parseOEmbed } from '../framecheck/oembed.ts';
import { frameVerdict } from '../framecheck/verdict.ts';
import type { OutboundFetcher } from '../outbound/fetcher.ts';
import { parseUnfurlMetadata } from '../unfurl/parse.ts';
import { fetchCaller, hopBudget } from './guard.ts';
import type { HostAppOptions } from './options.ts';
import { writeJSON } from '../route/json.ts';

const FRAME_LIMITS = {
  timeoutMs: 10_000,
  maxBytes: 256 << 10,
  maxRedirects: 5,
  truncate: true as const,
};
const MAX_OEMBED = 64 << 10;

function rawQueryWithoutMark(query: string): string {
  return query.startsWith('?') ? query.slice(1) : query;
}

function firstHeader(request: Request, name: string): string {
  return request.headers().get(name) ?? '';
}

function originAllowed(origin: string, allowed: string[]): boolean {
  for (const candidate of allowed) {
    if (equalsOrdinalIgnoreCase(candidate.trim(), origin)) {
      return true;
    }
  }
  return false;
}

function requestSelf(request: Request): string {
  const host = firstHeader(request, 'host');
  if (host === '') {
    return '';
  }
  return `http://${host}`;
}

export async function frameCheckHandler(
  options: HostAppOptions,
  request: Request,
  response: ResponseWriter,
): Promise<void> {
  if (!response.headersMut().getAll('vary').some((v) => equalsOrdinalIgnoreCase(v, 'Origin'))) {
    response.headersMut().add('Vary', 'Origin');
  }
  const target = queryFirst(rawQueryWithoutMark(request.query()), 'url');
  if (target === '') {
    await writeJSON(request, response, 400, '{"verdict":"unknown"}\n');
    return;
  }
  const started = Date.now();
  try {
    const fetched = await options.fetcher.get(target, {
      ...FRAME_LIMITS,
      hop: hopBudget(options, request),
      caller: fetchCaller(options, request),
    });
    try {
      if (fetched.statusCode < 200 || fetched.statusCode > 299) {
        await writeJSON(request, response, 200, '{"verdict":"unknown"}\n');
        return;
      }
      const embedder = chooseEmbedder({
        origin: firstHeader(request, 'origin'),
        hasOrigin: request.headers().contains('origin'),
        secFetchSite: firstHeader(request, 'sec-fetch-site'),
        embedder: queryFirst(rawQueryWithoutMark(request.query()), 'embedder'),
        self: requestSelf(request),
      }, (origin) => originAllowed(origin, options.allowedOrigins));
      const framing: Array<{ name: string; value: string }> = [];
      for (const name of ['content-security-policy', 'x-frame-options']) {
        for (const value of fetched.headers[name] ?? []) {
          framing.push({ name, value });
        }
      }
      const verdict = frameVerdict(fetched.finalUrl, embedder, framing);
      let body = `{"verdict":${JSON.stringify(verdict)},"link":${JSON.stringify(fetched.finalUrl)}`;
      const oEmbedURL = parseUnfurlMetadata(fetched.body, fetched.finalUrl).oembed;
      const redirects = fetched.redirects;
      fetched.release();
      const remaining = FRAME_LIMITS.timeoutMs - (Date.now() - started);
      const oembed = await fetchOEmbed(options.fetcher, oEmbedURL, remaining, FRAME_LIMITS.maxRedirects - redirects,
        hopBudget(options, request), fetchCaller(options, request));
      if (oembed !== undefined && !oembedEmpty(oembed)) {
        body = appendOembedJson(`${body}}`, oembed).replace(/}\s*$/, '}');
      } else {
        body += '}';
      }
      body += '\n';
      if (request.isCancelled()) {
        return;
      }
      await writeJSON(request, response, 200, body);
    } catch {
      fetched.release();
      throw new Error();
    }
  } catch {
    if (request.isCancelled()) {
      return;
    }
    await writeJSON(request, response, 200, '{"verdict":"unknown"}\n');
  }
}

async function fetchOEmbed(
  fetcher: OutboundFetcher,
  url: string,
  remainingMs: number,
  redirects: number,
  hop: () => boolean,
  caller: string,
): Promise<Record<string, unknown> | undefined> {
  if (url === '' || remainingMs <= 0 || redirects < 0 || !hop()) {
    return undefined;
  }
  const fetched = await fetcher.get(url, {
    timeoutMs: remainingMs,
    maxBytes: MAX_OEMBED,
    maxRedirects: redirects,
    hop,
    caller,
  });
  try {
    if (fetched.statusCode < 200 || fetched.statusCode > 299) {
      return undefined;
    }
    const answer = parseOEmbed(fetched.body);
    if (oembedEmpty(answer)) {
      return undefined;
    }
    return answer;
  } finally {
    fetched.release();
  }
}