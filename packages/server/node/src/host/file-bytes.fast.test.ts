/**
 * /file-bytes holds an outbound upload slot for as long as it reads the
 * answer. Each pool has four, so a refusal that forgets to hand its slot back
 * wedges the route after four of them: the fifth caller waits out the whole
 * 120 s fetch deadline for a slot nobody will free.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { ExactOriginPolicy, OutboundFetcher } from '../outbound/fetcher.ts';
import { POOL_SIZE } from '../outbound/permits.ts';
import { defaultTestHostOptions } from '../test-kit/invoke-host.ts';
import { invokeHost } from '../test-kit/invoke-host.ts';
import type { HostAppOptions } from './options.ts';

interface Origin {
  readonly baseUrl: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** Answers every path 404, the shortest route to a refusal that still fetched. */
function startMissingOrigin(): Promise<Origin> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('nope');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address === null || typeof address === 'string' ? 0 : address.port;

      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        stop: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

let origin: Origin | undefined;

afterEach(async () => {
  await origin?.stop();
  origin = undefined;
});

function fileBytesOptions(from: Origin): HostAppOptions {
  return {
    ...defaultTestHostOptions(),
    fileBytesEnabled: true,
    fetcher: new OutboundFetcher(new ExactOriginPolicy(from.baseUrl, from.port)),
  };
}

describe('file bytes', () => {
  it('hands its outbound slot back on a refusal, not only on an answer', async () => {
    origin = await startMissingOrigin();

    const options = fileBytesOptions(origin);
    const ask = (name: string): Promise<{ status: number }> => invokeHost(options, {
      method: 'GET',
      path: `/file-bytes?url=${encodeURIComponent(`${origin?.baseUrl ?? ''}/${name}.pdf`)}`,
    });

    // One more than the pool holds: the last one only answers if every
    // refusal before it gave its slot back.
    for (let attempt = 0; attempt <= POOL_SIZE; attempt += 1) {
      expect((await ask(`missing-${attempt}`)).status).toBe(502);
    }
  }, 20_000);
});
