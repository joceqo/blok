import { describe, expect, it } from 'vitest';

import {
  InboundBudget,
  TokenBucket,
  DEFAULT_INBOUND_BUDGET,
  type InboundBudgetOptions,
} from './inbound-budget.ts';

/**
 * One connection's inbound budget, the Node mirror of the C# SyncInboundBudget.
 * The thresholds asserted here are the ones the shared contract exercises over
 * a real socket (test/unit/server-conformance/sync-transport-contract.test.ts,
 * group `a served socket`): past them the host closes 1008 "inbound rate
 * exceeded". The clock is injected, so a second of refill costs no wall time.
 */

/** A hand-wound monotonic clock in milliseconds. */
const stopwatch = () => {
  const state = { ms: 1_000 };

  return {
    now: () => state.ms,
    advance: (ms: number) => {
      state.ms += ms;
    },
  };
};

const budgetOf = (now: () => number, overrides: Partial<InboundBudgetOptions> = {}) =>
  new InboundBudget({ ...DEFAULT_INBOUND_BUDGET, ...overrides }, now);

/** A sync update: type 0, sub-type 2, then a one-byte payload. Costs the sender alone. */
const update = () => Uint8Array.from([0, 2, 1, 42]);

/** What the contract sends: [0x80, 0x00] is a NON-canonical varuint zero, then SyncStep1. */
const nonCanonicalResync = () => Uint8Array.from([0x80, 0x00, 0x00, 0x00]);

/** A canonical SyncStep1 with an empty state vector. */
const resync = () => Uint8Array.from([0, 0, 0]);

const queryAwareness = () => Uint8Array.from([3]);

const awareness = (bytes: number) => {
  const frame = new Uint8Array(bytes);

  frame[0] = 1;

  return frame;
};

describe('TokenBucket', () => {
  it('is off when the rate is zero: any cost is admitted', () => {
    const clock = stopwatch();
    const bucket = new TokenBucket(clock.now, 0, 10);

    expect([bucket.tryTake(), bucket.tryTake(1_000_000), bucket.tryTake()]).toEqual([true, true, true]);
  });

  it('is off when the rate is negative', () => {
    const clock = stopwatch();

    expect(new TokenBucket(clock.now, -1, 10).tryTake(1_000)).toBe(true);
  });

  it('starts full, and spends the capacity before it refuses', () => {
    const clock = stopwatch();
    const bucket = new TokenBucket(clock.now, 1, 3);

    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('refuses a cost above the whole capacity even when full', () => {
    const clock = stopwatch();
    const bucket = new TokenBucket(clock.now, 100, 10);

    expect(bucket.tryTake(11)).toBe(false);
    // The refusal spent nothing: a payable cost still goes through.
    expect(bucket.tryTake(10)).toBe(true);
  });

  it('refills at the rate, and never above the capacity', () => {
    const clock = stopwatch();
    const bucket = new TokenBucket(clock.now, 2, 4);

    expect(bucket.tryTake(4)).toBe(true);
    clock.advance(500);
    expect(bucket.tryTake(2)).toBe(false);
    expect(bucket.tryTake(1)).toBe(true);

    clock.advance(60_000);
    expect(bucket.tryTake(4)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
  });
});

describe('InboundBudget: frames', () => {
  it('serves a burst of 100 frames and refuses the 101st', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 100 }, () => budget.allows(update()));

    expect(served.every(Boolean)).toBe(true);
    expect(budget.allows(update())).toBe(false);
  });

  it('refuses before the burst ends once the per-second rate binds', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);

    Array.from({ length: 100 }, () => budget.allows(update()));
    clock.advance(1_000);

    const refilled = Array.from({ length: 50 }, () => budget.allows(update()));

    expect(refilled.every(Boolean)).toBe(true);
    expect(budget.allows(update())).toBe(false);
  });
});

describe('InboundBudget: amplifiers', () => {
  it('serves 10 resyncs and refuses the 11th', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 10 }, () => budget.allows(resync()));

    expect(served.every(Boolean)).toBe(true);
    expect(budget.allows(resync())).toBe(false);
  });

  it('reads the type as a varuint: a non-canonical zero is still SyncStep1', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 10 }, () => budget.allows(nonCanonicalResync()));

    expect(served.every(Boolean)).toBe(true);
    expect(budget.allows(nonCanonicalResync())).toBe(false);
  });

  it('meters queryAwareness as an amplifier', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 10 }, () => budget.allows(queryAwareness()));

    expect(served.every(Boolean)).toBe(true);
    expect(budget.allows(queryAwareness())).toBe(false);
  });

  it('leaves a plain update alone: 20 of them cost no amplifier token', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 20 }, () => budget.allows(update()));

    expect(served.every(Boolean)).toBe(true);
    expect(budget.allows(resync())).toBe(true);
  });

  it('refills at 60 a minute: one more resync a second later', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);

    Array.from({ length: 10 }, () => budget.allows(resync()));
    expect(budget.allows(resync())).toBe(false);

    clock.advance(1_000);
    expect(budget.allows(resync())).toBe(true);
    expect(budget.allows(resync())).toBe(false);
  });
});

describe('InboundBudget: presence bytes', () => {
  it('refuses one awareness frame a byte over the 512 KiB burst', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);

    expect(budget.allows(awareness(512 * 1024 + 1))).toBe(false);
  });

  it('serves an awareness frame of exactly the burst', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);

    expect(budget.allows(awareness(512 * 1024))).toBe(true);
    expect(budget.allows(awareness(1_024))).toBe(false);
  });

  it('refills at 128 KiB a second', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);

    expect(budget.allows(awareness(512 * 1024))).toBe(true);
    clock.advance(1_000);
    expect(budget.allows(awareness(128 * 1024))).toBe(true);
    expect(budget.allows(awareness(1))).toBe(false);
  });

  it('charges no presence bytes to a sync frame of the same size', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const big = new Uint8Array(512 * 1024 + 1);

    big[0] = 0;
    big[1] = 2;
    expect(budget.allows(big)).toBe(true);
  });
});

describe('InboundBudget: undecodable frames', () => {
  it('treats an empty frame as plain rather than throwing', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);

    expect(budget.allows(new Uint8Array(0))).toBe(true);
  });

  it('treats a truncated varuint as plain', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 20 }, () => budget.allows(Uint8Array.from([0x80])));

    expect(served.every(Boolean)).toBe(true);
  });

  it('treats a sync frame with no sub-type as plain', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 20 }, () => budget.allows(Uint8Array.from([0])));

    expect(served.every(Boolean)).toBe(true);
  });
});

describe('InboundBudget: receives per message', () => {
  it('serves a message in 16 receives and refuses the 17th', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 16 }, () => budget.allowsReceive(4));

    expect(served.every(Boolean)).toBe(true);
    expect(budget.allowsReceive(4)).toBe(false);
  });

  it('grants one more receive per 64 bytes of the message', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 17 }, (_unused, index) => budget.allowsReceive((index + 1) * 64));

    expect(served.every(Boolean)).toBe(true);
    // 17 receives carrying 17 * 64 bytes: the allowance is 16 + 17.
    expect(Array.from({ length: 16 }, () => budget.allowsReceive(17 * 64)).every(Boolean)).toBe(true);
    expect(budget.allowsReceive(17 * 64)).toBe(false);
  });

  it('counts the whole 64-byte slice, never a part of one', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);
    const served = Array.from({ length: 16 }, () => budget.allowsReceive(63));

    expect(served.every(Boolean)).toBe(true);
    expect(budget.allowsReceive(63)).toBe(false);
  });

  it('starts the allowance over at the end of each message', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);

    Array.from({ length: 16 }, () => budget.allowsReceive(4));
    budget.endMessage();

    const next = Array.from({ length: 16 }, () => budget.allowsReceive(4));

    expect(next.every(Boolean)).toBe(true);
    expect(budget.allowsReceive(4)).toBe(false);
  });

  it('does not spend a frame token: the receive counter is its own gate', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now);

    Array.from({ length: 16 }, () => budget.allowsReceive(4));
    budget.endMessage();

    const served = Array.from({ length: 100 }, () => budget.allows(update()));

    expect(served.every(Boolean)).toBe(true);
  });
});

describe('InboundBudget: per connection', () => {
  it('gives each connection its own buckets', () => {
    const clock = stopwatch();
    const first = budgetOf(clock.now);
    const second = budgetOf(clock.now);

    Array.from({ length: 100 }, () => first.allows(update()));
    expect(first.allows(update())).toBe(false);
    expect(second.allows(update())).toBe(true);
  });

  it('gives each connection its own receive counter', () => {
    const clock = stopwatch();
    const first = budgetOf(clock.now);
    const second = budgetOf(clock.now);

    Array.from({ length: 17 }, () => first.allowsReceive(4));
    expect(second.allowsReceive(4)).toBe(true);
  });
});

describe('InboundBudget: the options turn each bucket off', () => {
  it('admits any number of frames at zero frames per second', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now, { framesPerSecond: 0 });
    const served = Array.from({ length: 500 }, () => budget.allows(update()));

    expect(served.every(Boolean)).toBe(true);
  });

  it('admits any number of resyncs at zero resyncs per minute', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now, { resyncsPerMinute: 0 });
    const served = Array.from({ length: 80 }, () => budget.allows(resync()));

    expect(served.every(Boolean)).toBe(true);
  });

  it('admits an oversized awareness frame at zero awareness bytes per second', () => {
    const clock = stopwatch();
    const budget = budgetOf(clock.now, { awarenessBytesPerSecond: 0 });

    expect(budget.allows(awareness(4 * 1024 * 1024))).toBe(true);
  });

  it('carries the C# defaults', () => {
    expect(DEFAULT_INBOUND_BUDGET).toEqual({
      framesPerSecond: 50,
      burstFrames: 100,
      resyncsPerMinute: 60,
      awarenessBytesPerSecond: 128 * 1024,
    });
  });
});
