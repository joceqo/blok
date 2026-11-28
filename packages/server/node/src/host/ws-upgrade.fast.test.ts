import { expect, it } from 'vitest';
import { Headers } from '../http/headers.ts';
import type { Request } from '../http/request.ts';
import { isWebSocketUpgrade, toUpgradeMessage } from './ws-upgrade.ts';

/** Only the parts of Request these helpers read. */
function request(method: string, target: string, lines: [string, string][]): Request {
  const headers = new Headers();
  for (const [name, value] of lines) headers.add(name, value);
  return { method: () => method, target: () => target, headers: () => headers } as unknown as Request;
}

it('recognises an upgrade whatever the casing', () => {
  expect(isWebSocketUpgrade(request('GET', '/sync/d', [
    ['Upgrade', 'WebSocket'], ['Connection', 'Upgrade'],
  ]))).toBe(true);
});

it('recognises an upgrade inside a multi-valued Connection header', () => {
  // Browsers and proxies send "keep-alive, Upgrade"; a strict equality check misses it.
  expect(isWebSocketUpgrade(request('GET', '/sync/d', [
    ['Upgrade', 'websocket'], ['Connection', 'keep-alive, Upgrade'],
  ]))).toBe(true);
});

it('refuses anything that is not a websocket GET upgrade', () => {
  expect(isWebSocketUpgrade(request('GET', '/sync/d', [['Connection', 'Upgrade']]))).toBe(false);
  expect(isWebSocketUpgrade(request('GET', '/sync/d', [['Upgrade', 'websocket']]))).toBe(false);
  expect(isWebSocketUpgrade(request('GET', '/sync/d', [
    ['Upgrade', 'h2c'], ['Connection', 'Upgrade'],
  ]))).toBe(false);
  expect(isWebSocketUpgrade(request('POST', '/sync/d', [
    ['Upgrade', 'websocket'], ['Connection', 'Upgrade'],
  ]))).toBe(false);
});

it('hands ws a message with lower-cased headers it can read', () => {
  const message = toUpgradeMessage(request('GET', '/sync/doc-42', [
    ['Upgrade', 'websocket'],
    ['Connection', 'Upgrade'],
    ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='],
    ['Sec-WebSocket-Version', '13'],
    ['Sec-WebSocket-Protocol', 'blok-sync.v2, ticket-abc'],
  ]));

  expect(message.method).toBe('GET');
  expect(message.url).toBe('/sync/doc-42');
  expect(message.httpVersion).toBe('1.1');
  // ws indexes headers in lower case and nothing else.
  expect(message.headers['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
  expect(message.headers['sec-websocket-version']).toBe('13');
  // The door selected, so `ws` is handed its answer and never the raw list.
  expect(message.headers['sec-websocket-protocol']).toBeUndefined();
});

it('hands ws the one protocol the door selected', () => {
  const headers: [string, string][] = [
    ['Upgrade', 'websocket'],
    ['Connection', 'Upgrade'],
    ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='],
    ['Sec-WebSocket-Version', '13'],
    ['Sec-WebSocket-Protocol', 'blok-sync.v2, ticket-abc'],
  ];

  expect(toUpgradeMessage(request('GET', '/sync/doc-42', headers), 'blok-sync.v2')
    .headers['sec-websocket-protocol']).toBe('blok-sync.v2');
});
