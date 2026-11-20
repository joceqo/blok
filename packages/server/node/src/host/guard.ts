import { equalsOrdinalIgnoreCase } from '../dotnet/ordinal.ts';
import { isFieldValue } from '../http/headers.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { verifyTicket } from '../auth/ticket.ts';
import { RateLimiter } from './rate-limit.ts';
import type { HostAppOptions } from './options.ts';
import { writePlain } from '../route/respond.ts';
import { hostAllowed } from './host-check.ts';

const rateKeys = new WeakMap<Request, string>();

export function rateKeyFromRequest(request: Request): string {
  return rateKeys.get(request) ?? `addr:${request.remoteAddr ?? '0.0.0.0'}`;
}

function firstHeader(request: Request, name: string): string {
  const direct = request.headers().get(name);
  return direct ?? '';
}

function requestOrigin(request: Request): string {
  return firstHeader(request, 'origin');
}

function originAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (origin === '' || !isFieldValue(origin)) {
    return false;
  }
  for (const candidate of allowedOrigins) {
    if (equalsOrdinalIgnoreCase(candidate.trim(), origin)) {
      return true;
    }
  }
  return false;
}

function remoteKey(request: Request): string {
  const addr = request.remoteAddr ?? '0.0.0.0';
  const port = request.remotePort ?? 0;
  return `${addr}:${port}`;
}

export function fetchCaller(options: HostAppOptions, request: Request): string {
  if (options.rateLimitPerMinute <= 0) {
    return '';
  }
  return rateKeyFromRequest(request);
}

export async function guardRequest(
  options: HostAppOptions,
  request: Request,
  response: ResponseWriter,
  requireWrite: boolean,
): Promise<boolean> {
  const host = firstHeader(request, 'host');
  if (
    options.loopbackHostCheck
    && options.auth !== 'ticket'
    && !hostAllowed(host, options.allowedHostNames)
  ) {
    await writePlain(request, response, 421, 'host not allowed\n');
    return false;
  }
  const origin = requestOrigin(request);
  const allowed = originAllowed(origin, options.allowedOrigins);
  const hasOrigin = request.headers().contains('origin');
  const secFetchSite = firstHeader(request, 'sec-fetch-site');
  const required = options.auth === 'ticket' || hasOrigin || equalsOrdinalIgnoreCase(secFetchSite, 'cross-site');
  if (required && !allowed) {
    await writePlain(request, response, 403, 'origin not allowed\n');
    return false;
  }
  if (allowed) {
    response.headersMut().set('Access-Control-Allow-Origin', origin);
    response.headersMut().add('Vary', 'Origin');
  }
  let key = `addr:${remoteKey(request)}`;
  if (options.auth === 'ticket') {
    const authorization = firstHeader(request, 'authorization');
    let pass = authorization;
    if (pass.startsWith('Bearer ')) {
      pass = pass.slice(7);
    }
    if (pass === '') {
      await writePlain(request, response, 401, 'missing pass\n');
      return false;
    }
    const verified = verifyTicket(options.secret, pass, Date.now());
    if (!verified.ok) {
      await writePlain(request, response, 401, 'invalid pass\n');
      return false;
    }
    if (requireWrite && !verified.claims.write) {
      await writePlain(request, response, 403, 'write access required\n');
      return false;
    }
    if (verified.claims.user !== '') {
      key = `user:${verified.claims.user}`;
    }
  }
  if (!options.rateLimiter.allow(key)) {
    await writePlain(request, response, 429, 'rate limit exceeded\n');
    return false;
  }
  rateKeys.set(request, key);
  return true;
}

export function hopBudget(options: HostAppOptions, request: Request): () => boolean {
  const key = rateKeyFromRequest(request);
  return () => options.rateLimiter.allow(key);
}