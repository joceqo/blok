import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { ExactOriginPolicy, OutboundFailure, OutboundFetcher } from './fetcher.ts';
import { POOL_SIZE } from './permits.ts';

interface HoldingOrigin {
  readonly baseUrl: string;
  readonly peak: () => number;
  readonly port: number;
  releaseAll(): void;
  stop(): Promise<void>;
}

function startHoldingOrigin(): Promise<HoldingOrigin> {
  const waiting: Array<() => void> = [];
  let current = 0;
  let peak = 0;
  const server: Server = createServer((_request, response) => {
    current += 1;
    peak = Math.max(peak, current);
    waiting.push(() => {
      current -= 1;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<html><head><title>held</title></head><body></body></html>');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address === null || typeof address === 'string' ? 0 : address.port;

      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        peak: () => peak,
        releaseAll: () => {
          while (waiting.length > 0) {
            waiting.shift()?.();
          }
        },
        stop: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

let origin: HoldingOrigin | undefined;

afterEach(async () => {
  origin?.releaseAll();
  await origin?.stop();
  origin = undefined;
});

describe('OutboundFetcher concurrency', () => {
  it('holds a pool to four fetches at the origin, each pool its own four', async () => {
    origin = await startHoldingOrigin();
    const held = origin;
    const fetcher = new OutboundFetcher(new ExactOriginPolicy(held.baseUrl, held.port));
    // The outcome is taken here, never thrown: an assertion below can leave
    // nine fetches in flight, and a rejection nobody is awaiting yet would
    // surface as an unhandled error that buries the real failure.
    const fetch = (upload: boolean, path: string): Promise<number | string> => fetcher
      .get(`${held.baseUrl}${path}`, {
        timeoutMs: 30_000,
        maxBytes: 2 << 20,
        maxRedirects: 5,
        upload,
      })
      .then((response) => {
        response.release();

        return response.statusCode;
      })
      .catch((error: unknown) => `${path}: ${error instanceof Error ? error.message : String(error)}`);
    const requests = [0, 1, 2, 3, 4].flatMap((index) => [
      fetch(false, `/hold/page-${index}`),
      fetch(true, `/hold/photo-${index}.png`),
    ]);
    // The two that waited reach the origin only once a slot frees, so one
    // release is not enough to drain them.
    const drained = Promise.all(requests);
    let open = true;

    void drained.then(() => {
      open = false;
    });

    try {
      // Long enough for a ninth fetch to arrive if the pools would let it.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(held.peak()).toBe(POOL_SIZE * 2);

      while (open) {
        held.releaseAll();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(await drained).toEqual(Array.from({ length: 10 }, () => 200));
    } finally {
      held.releaseAll();
      await drained;
    }
  }, 30_000);

  it('gives up on an origin that holds the reply past the deadline', async () => {
    origin = await startHoldingOrigin();
    const held = origin;
    const fetcher = new OutboundFetcher(new ExactOriginPolicy(held.baseUrl, held.port));

    await expect(fetcher.get(`${held.baseUrl}/hold/page-0`, {
      timeoutMs: 300,
      maxBytes: 2 << 20,
      maxRedirects: 5,
    })).rejects.toMatchObject({ failure: OutboundFailure.TimedOut });
  }, 30_000);
});
