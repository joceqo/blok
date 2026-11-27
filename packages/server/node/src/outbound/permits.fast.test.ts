import { describe, expect, it } from 'vitest';

import type { OutboundWait } from '../collab/observe.ts';
import { OutboundPermits, POOL_SIZE, sharedOutboundPermits } from './permits.ts';

describe('OutboundPermits', () => {
  it('limits the check pool to four concurrent slots', async () => {
    const permits = sharedOutboundPermits;
    const deadline = Date.now() + 10_000;
    let peak = 0;
    let inFlight = 0;
    const attempt = async (): Promise<void> => {
      const release = await permits.acquire(false, '', deadline);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 8 }, () => attempt()));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('blocks a fifth acquire until one of four slots is released', async () => {
    const deadline = Date.now() + 5000;
    const releases = await Promise.all(
      Array.from({ length: 4 }, () => sharedOutboundPermits.acquire(false, '', deadline)),
    );
    let fifthDone = false;
    void sharedOutboundPermits.acquire(false, '', deadline).then(() => {
      fifthDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fifthDone).toBe(false);
    for (const release of releases) {
      release();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fifthDone).toBe(true);
  });

  it('limits ten concurrent upload acquires to four in flight', async () => {
    const deadline = Date.now() + 10_000;
    let peak = 0;
    let inFlight = 0;
    const attempt = async (): Promise<void> => {
      const release = await sharedOutboundPermits.acquire(true, '', deadline);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 10 }, () => attempt()));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('limits ten concurrent acquires on the shared pool to four in flight', async () => {
    const deadline = Date.now() + 10_000;
    let peak = 0;
    let inFlight = 0;
    const attempt = async (): Promise<void> => {
      const release = await sharedOutboundPermits.acquire(false, '', deadline);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 10 }, () => attempt()));
    expect(peak).toBeLessThanOrEqual(4);
  });
});
/**
 * A slot taken and never given back turns every later call into a silent wait
 * for the whole deadline — two minutes, on the doc endpoint. Two leaked
 * permits went unnoticed until a test timed out, because nothing anywhere
 * said that a caller was waiting.
 */
describe('@fast reporting an outbound wait', () => {
  it('says nothing when a caller takes a free slot', async () => {
    const permits = new OutboundPermits();
    const waits: OutboundWait[] = [];
    permits.onWait = (event) => waits.push(event);

    (await permits.acquire(false, 'u-1', Date.now() + 1000))();

    expect(waits).toEqual([]);
  });

  it('reports the caller that had to queue, once it has its slot', async () => {
    const permits = new OutboundPermits();
    const waits: OutboundWait[] = [];
    permits.onWait = (event) => waits.push(event);
    const deadline = Date.now() + 5000;
    const held = await Promise.all(
      Array.from({ length: POOL_SIZE }, (_, index) => permits.acquire(false, `holder-${index}`, deadline)),
    );
    const queued = permits.acquire(false, 'latecomer', deadline);

    // Long enough for the latecomer to reach the queue: released before that,
    // it would find a free slot and never have waited at all.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waits).toEqual([]);
    for (const release of held) {
      release();
    }
    (await queued)();

    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ upload: false, caller: 'latecomer', granted: true });
  });

  it('reports a wait that never got a slot, and calls it a failure', async () => {
    const permits = new OutboundPermits();
    const waits: OutboundWait[] = [];
    permits.onWait = (event) => waits.push(event);
    const deadline = Date.now() + 40;
    const held = await Promise.all(
      Array.from({ length: POOL_SIZE }, (_, index) => permits.acquire(true, `holder-${index}`, deadline)),
    );

    await expect(permits.acquire(true, 'starved', deadline)).rejects.toThrow('timed out');
    expect(waits).toEqual([
      { upload: true, caller: 'starved', waitedMs: expect.any(Number) as number, granted: false },
    ]);
    for (const release of held) {
      release();
    }
  });
});
