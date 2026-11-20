import { describe, expect, it } from 'vitest';

import { OutboundPermits } from './permits.ts';

describe('OutboundPermits', () => {
  it('limits the check pool to four concurrent slots', async () => {
    const permits = new OutboundPermits();
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
});