import type { Request } from '../http/request.ts';
import { isWebSocketUpgrade } from './ws-upgrade.ts';

export const PROTOCOL_V1 = 'blok-sync.v1';
export const PROTOCOL_V2 = 'blok-sync.v2';

/** Body of every 426: the three reasons a door refuses before it reads anything else. */
export const UPGRADE_REQUIRED_BODY = 'WebSocket upgrade required\n';

/** A 16-byte key in the one encoding RFC 6455 allows for it. */
const KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

/**
 * Every code point .NET calls a space. JavaScript's own trim is a different
 * set on both ends — it keeps U+0085 and drops U+FEFF — so an offer trimmed
 * with it would not match what the reference host accepts.
 */
function isUnicodeSpace(code: number): boolean {
  return (code >= 0x09 && code <= 0x0d)
    || code === 0x20
    || code === 0x85
    || code === 0xa0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000;
}

export function trimUnicodeSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isUnicodeSpace(value.charCodeAt(start))) {
    start += 1;
  }
  while (end > start && isUnicodeSpace(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return value.slice(start, end);
}

/** A document id has to name one path segment; `a%2Fb` names two. */
export function isSingleSegment(doc: string): boolean {
  const lower = doc.toLowerCase();
  return doc !== '' && doc !== '.' && doc !== '..'
    && !/[\\/]/.test(doc) && !lower.includes('%2f') && !lower.includes('%5c');
}

/**
 * Why this request cannot become a socket, or undefined when it can. Every
 * answer here is a 426: the client asked for HTTP, or for a handshake no
 * version of this protocol speaks.
 */
export function upgradeRefusal(request: Request): string | undefined {
  if (!isWebSocketUpgrade(request)) {
    return UPGRADE_REQUIRED_BODY;
  }
  const headers = request.headers();
  if ((headers.get('sec-websocket-version') ?? '').trim() !== '13') {
    return UPGRADE_REQUIRED_BODY;
  }
  if (!KEY_PATTERN.test((headers.get('sec-websocket-key') ?? '').trim())) {
    return UPGRADE_REQUIRED_BODY;
  }
  return undefined;
}

/**
 * The offer list, from however many Sec-WebSocket-Protocol headers it arrived
 * in. A browser sends one header, a proxy may split it, and both forms name
 * the same offers.
 */
export function offeredSubprotocols(request: Request): string[] {
  const offers: string[] = [];
  for (const value of request.headers().getAll('sec-websocket-protocol')) {
    for (const part of value.split(',')) {
      const trimmed = trimUnicodeSpace(part);
      if (trimmed !== '') {
        offers.push(trimmed);
      }
    }
  }
  return offers;
}

/**
 * The protocol to echo. v2 needs a journal behind it, so a host without one
 * never selects it even when a client offers it; anything else than these two
 * exact spellings is a pass riding in the offer list, not a protocol.
 */
export function selectSubprotocol(offers: readonly string[], journal: boolean): string | undefined {
  if (journal && offers.includes(PROTOCOL_V2)) {
    return PROTOCOL_V2;
  }
  return offers.includes(PROTOCOL_V1) ? PROTOCOL_V1 : undefined;
}

/** The offers that are not protocol names: a browser socket carries its pass here. */
export function offeredPasses(offers: readonly string[]): string[] {
  return offers.filter((offer) => offer !== PROTOCOL_V1 && offer !== PROTOCOL_V2);
}
