/**
 * A handler that refuses a request without reading its body must be able to
 * end the connection: the unread bytes are still on the wire, and a kept-alive
 * socket would read the next request out of the middle of them.
 */

import { createServer, connect, type Server, type Socket } from 'node:net';
import { afterEach, expect, it } from 'vitest';

import { defaultConfig } from './config.ts';
import { serve } from './conn.ts';
import type { Request } from './request.ts';
import type { ResponseWriter } from './response.ts';
import { Shared } from './server.ts';

let listener: Server | undefined;

afterEach(async () => {
  const open = listener;

  listener = undefined;
  if (open !== undefined) {
    await new Promise<void>((resolve) => open.close(() => resolve()));
  }
});

async function hostOne(
  handler: (request: Request, response: ResponseWriter) => Promise<void>,
): Promise<Socket> {
  const shared = new Shared(handler, defaultConfig());
  const server = createServer((socket) => void serve(shared, socket, () => {}));

  listener = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const { port } = server.address() as { port: number };
  const client = connect({ host: '127.0.0.1', port });

  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });

  return client;
}

it('ends a connection the handler closed, and says so in the head', async () => {
  const client = await hostOne(async (_request, response) => {
    await response.closeConnection();
    await response.start(413);
  });
  const parts: Buffer[] = [];

  client.on('data', (chunk: Buffer) => parts.push(chunk));
  // No Connection: close of its own, and the body stays unread on the wire.
  client.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 40\r\n\r\n' + ' '.repeat(40));

  const ended = await Promise.race([
    new Promise<boolean>((done) => client.once('end', () => done(true))),
    new Promise<boolean>((done) => setTimeout(() => done(false), 2_000)),
  ]);
  const head = Buffer.concat(parts).toString('latin1');

  expect([head.split('\r\n')[0], ended]).toEqual(['HTTP/1.1 413 Payload Too Large', true]);
  expect(head).toMatch(/\r\nConnection: close\r\n/);
  client.destroy();
}, 10_000);

it('keeps a connection the handler left alone', async () => {
  const client = await hostOne(async (_request, response) => {
    await response.start(204);
  });
  const parts: Buffer[] = [];

  client.on('data', (chunk: Buffer) => parts.push(chunk));
  client.write('GET /x HTTP/1.1\r\nHost: x\r\n\r\n');
  await new Promise<void>((resolve) => client.once('data', () => resolve()));

  const ended = await Promise.race([
    new Promise<boolean>((done) => client.once('end', () => done(true))),
    new Promise<boolean>((done) => setTimeout(() => done(false), 300)),
  ]);

  expect([Buffer.concat(parts).toString('latin1').split('\r\n')[0], ended])
    .toEqual(['HTTP/1.1 204 No Content', false]);
  client.destroy();
}, 10_000);
