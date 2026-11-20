import { describe, expect, it } from 'vitest';

import { OutboundPermits, sharedOutboundPermits } from './permits.ts';

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