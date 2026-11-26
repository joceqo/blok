import { equalsOrdinalIgnoreCase } from '../dotnet/ordinal.ts';
import { isFieldValue } from '../http/headers.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { verifyTicket } from '../auth/ticket.ts';
import type { HostAppOptions } from './options.ts';
import { writePlain } from '../route/respond.ts';
import { hostAllowed } from './host-check.ts';

const rateKeys = new WeakMap<Request, string>();

export function rateKeyFromRequest(request: Request): string {
  return rateKeys.get(request) ?? addressKey(request);
}

/** The limiter's key for a caller no pass has named yet. */
export function addressKey(request: Request): string {
  return `addr:${request.remoteAddr() ?? '0.0.0.0'}`;
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

/**
 * The host's one host-header policy. A ticket proves which deployment the
 * caller meant, so only a host without one needs the name checked.
 */
export function hostRefused(options: HostAppOptions, request: Request): boolean {
  return options.loopbackHostCheck
    && options.auth !== 'ticket'
    && !hostAllowed(firstHeader(request, 'host'), options.allowedHostNames);
}

/**
 * The host's one origin policy, shared by the HTTP routes and the sync door.
 * `origin` is reported so a route that answers can echo it back; a door that
 * hands the connection to `ws` has no answer of its own to decorate.
 */
export function inspectOrigin(
  options: HostAppOptions,
  request: Request,
): { origin: string; allowed: boolean; refused: boolean } {
  const origin = requestOrigin(request);
  const allowed = originAllowed(origin, options.allowedOrigins);
  const hasOrigin = request.headers().contains('origin');
  const secFetchSite = firstHeader(request, 'sec-fetch-site');
  const required = options.auth === 'ticket'
    || hasOrigin
    || equalsOrdinalIgnoreCase(secFetchSite, 'cross-site');
  return { origin, allowed, refused: required && !allowed };
}

/** Why a pass was not honoured. Each reason is a close reason on the sync socket. */
export type PassFailure = 'missing pass' | 'invalid pass' | 'pass is for another document' | 'pass names no user';

export interface PassVerdict {
  ok: boolean;
  reason?: PassFailure;
  user: string;
  write: boolean;
}

/**
 * The ticket rules in the one order both callers read them in. A pass that
 * names no user still verified: the HTTP routes accept it and bill its
 * address, while the sync door needs a member to count sockets against.
 */
export function classifyPass(secret: string, pass: string, doc: string | undefined, nowMs: number): PassVerdict {
  if (pass === '') {
    return { ok: false, reason: 'missing pass', user: '', write: false };
  }
  const verified = verifyTicket(secret, pass, nowMs);
  if (!verified.ok) {
    return { ok: false, reason: 'invalid pass', user: '', write: false };
  }
  const { doc: scope, user, write } = verified.claims;
  if (doc !== undefined && scope !== doc) {
    return { ok: false, reason: 'pass is for another document', user, write };
  }
  if (user === '') {
    return { ok: false, reason: 'pass names no user', user, write };
  }
  return { ok: true, user, write };
}

export function fetchCaller(options: HostAppOptions, request: Request): string {
  if (options.rateLimitPerMinute <= 0) {
    return '';
  }
  return rateKeyFromRequest(request);
}

/**
 * `presented` is the pass when the request cannot carry an Authorization
 * header. A browser WebSocket upgrade has only the subprotocol list, so the
 * upgrade route resolves the pass there and hands it in — origin, document
 * scope, write scope and the rate-limit key stay one implementation.
 */
export async function guardRequest(
  options: HostAppOptions,
  request: Request,
  response: ResponseWriter,
  requireWrite: boolean,
  doc?: string,
  presented?: string,
): Promise<boolean> {
  if (hostRefused(options, request)) {
    await writePlain(request, response, 421, 'host not allowed\n');
    return false;
  }
  const { origin, allowed, refused } = inspectOrigin(options, request);
  if (refused) {
    await writePlain(request, response, 403, 'origin not allowed\n');
    return false;
  }
  if (allowed) {
    response.headersMut().set('Access-Control-Allow-Origin', origin);
    response.headersMut().add('Vary', 'Origin');
  }
  let key = addressKey(request);
  if (options.auth === 'ticket') {
    const authorization = firstHeader(request, 'authorization');
    let pass = presented ?? authorization;
    if (presented === undefined && pass.startsWith('Bearer ')) {
      pass = pass.slice(7);
    }
    const verdict = classifyPass(options.secret, pass, doc, Date.now());
    if (verdict.reason === 'missing pass' || verdict.reason === 'invalid pass') {
      await writePlain(request, response, 401, `${verdict.reason}\n`);
      return false;
    }
    if (requireWrite && !verdict.write) {
      await writePlain(request, response, 403, 'write access required\n');
      return false;
    }
    if (verdict.reason === 'pass is for another document') {
      await writePlain(request, response, 403, 'pass is for another document\n');
      return false;
    }
    if (verdict.user !== '') {
      key = `user:${verdict.user}`;
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