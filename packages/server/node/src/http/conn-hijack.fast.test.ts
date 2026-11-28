/** A hijacked exchange owns its socket for the whole session, past any request timeout. */

import { createServer, connect, type Server, type Socket } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig } from './config.ts';
import { serve } from './conn.ts';
import type { Request } from './request.ts';
import type { ResponseWriter } from './response.ts';
import { Shared } from './server.ts';

const REQUEST_TIMEOUT_MS = 60;

let listener: Server | undefined;

afterEach(async () => {
  const open = listener;
  listener = undefined;
  if (open !== undefined) {
    await new Promise<void>((resolve) => open.close(() => resolve()));
  }
});

/**
 * Runs `handler` over a real socket pair with a short request timeout, and
 * hands back the client end once the handler has answered.
 */
async function hostOne(
  handler: (request: Request, response: ResponseWriter) => Promise<void>,
): Promise<Socket> {
  const config = { ...defaultConfig(), requestTimeoutMs: REQUEST_TIMEOUT_MS };
  const shared = new Shared(handler, config);
  const server = createServer((socket) => void serve(shared, socket, () => {}));
  listener = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const client = connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  client.write('GET /sync/doc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  await new Promise<void>((resolve) => client.once('data', () => resolve()));
  return client;
}

it('keeps a hijacked session alive past the request timeout', async () => {
  // The session ends when the handler returns, so it returns only on close.
  let endSession: () => void = () => {};
  const session = new Promise<void>((resolve) => {
    endSession = resolve;
  });
  const client = await hostOne(async (_request, response) => {
    const { socket } = await response.hijack();
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
    await session;
    socket.destroy();
  });

  let closed = false;
  client.once('close', () => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, REQUEST_TIMEOUT_MS * 4));

  expect(closed).toBe(false);

  endSession();
  client.destroy();
});

it('still times out a handler that never hijacks', async () => {
  const client = await hostOne(async (_request, response) => {
    await response.start(200);
    await response.write(new TextEncoder().encode('head'));
    await new Promise(() => {});
  });

  const closed = await new Promise<boolean>((resolve) => {
    client.once('close', () => resolve(true));
    setTimeout(() => resolve(false), REQUEST_TIMEOUT_MS * 8);
  });

  expect(closed).toBe(true);
  client.destroy();
});
