import type { Request } from '../http/request.ts';

/** The shape `ws`'s handleUpgrade reads out of a Node IncomingMessage. */
export interface UpgradeMessage {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string>;
}

const HOP_HEADERS = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version',
  'sec-websocket-protocol', 'sec-websocket-extensions', 'origin', 'host', 'authorization'];

/**
 * A GET whose Connection lists `upgrade` and whose Upgrade names `websocket`.
 * Connection is a token list — proxies routinely send `keep-alive, Upgrade` — so an
 * equality test on the whole value would miss real upgrades.
 */
export function isWebSocketUpgrade(request: Request): boolean {
  if (request.method().toUpperCase() !== 'GET') return false;

  const headers = request.headers();
  if (headers.get('upgrade')?.trim().toLowerCase() !== 'websocket') return false;

  // Connection is a token list; Headers.hasToken already splits and compares it.
  return headers.hasToken('connection', 'upgrade');
}

/**
 * Adapts this host's hand-written Request to what `ws` expects. `ws` only indexes
 * headers in lower case, so anything it needs is copied down.
 *
 * `protocol` is the offer the door already selected. `ws` would otherwise parse
 * the raw offer list itself with a stricter grammar than the door's — an offer
 * padded with a Unicode space, or a pass riding beside the protocol, aborts its
 * handshake with a 400 — so the door hands it the one answer it must echo, and
 * omits the header entirely when there is none.
 */
export function toUpgradeMessage(request: Request, protocol?: string): UpgradeMessage {
  const headers = request.headers();
  const copied: Record<string, string> = {};

  for (const name of HOP_HEADERS) {
    const value = headers.get(name);
    if (value !== undefined) copied[name] = value;
  }
  if (protocol === undefined) {
    delete copied['sec-websocket-protocol'];
  } else {
    copied['sec-websocket-protocol'] = protocol;
  }

  return { method: request.method(), url: request.target(), httpVersion: '1.1', headers: copied };
}
