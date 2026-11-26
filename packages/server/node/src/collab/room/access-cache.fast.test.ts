import { expect, it, vi } from 'vitest';
import { createAccessCache } from './access-cache.ts';

/** A clock the test moves by hand; the cache never reads the wall clock itself. */
const clock = (start = 0) => { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

it('joins concurrent callers onto one load', async () => {
  const time = clock();
  const cache = createAccessCache<string, number>({ ttlMs: 1000, now: time.now });
  let settle: (value: number) => void = () => {};
  const load = vi.fn(() => new Promise<number>((resolve) => { settle = resolve; }));

  const callers = [cache.resolve('a', load), cache.resolve('a', load), cache.resolve('a', load)];
  settle(7);

  expect(await Promise.all(callers)).toEqual([7, 7, 7]);
  expect(load).toHaveBeenCalledOnce();
});

it('serves a fresh entry and reloads once it expires', async () => {
  const time = clock();
  const cache = createAccessCache<string, number>({ ttlMs: 1000, now: time.now });
  const load = vi.fn(async () => 1);

  expect(await cache.resolve('a', load)).toBe(1);
  time.advance(999);
  expect(await cache.resolve('a', load)).toBe(1);
  expect(load).toHaveBeenCalledOnce();

  time.advance(1);
  expect(await cache.resolve('a', load)).toBe(1);
  expect(load).toHaveBeenCalledTimes(2);
});

it('keeps keys independent', async () => {
  const time = clock();
  const cache = createAccessCache<string, string>({ ttlMs: 1000, now: time.now });

  expect(await cache.resolve('a', async () => 'A')).toBe('A');
  expect(await cache.resolve('b', async () => 'B')).toBe('B');
  expect(await cache.resolve('a', async () => 'changed')).toBe('A');
});

it('reloads after invalidation, by key or wholesale', async () => {
  const time = clock();
  const cache = createAccessCache<string, string>({ ttlMs: 1000, now: time.now });

  await cache.resolve('a', async () => 'first');
  await cache.resolve('b', async () => 'first');

  cache.invalidate('a');
  expect(await cache.resolve('a', async () => 'second')).toBe('second');
  expect(await cache.resolve('b', async () => 'second')).toBe('first');

  cache.invalidate();
  expect(await cache.resolve('b', async () => 'third')).toBe('third');
});

it('never caches a failed load', async () => {
  const time = clock();
  const cache = createAccessCache<string, string>({ ttlMs: 1000, now: time.now });

  await expect(cache.resolve('a', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  // A transient failure must not pin the key to an error for the whole TTL.
  expect(await cache.resolve('a', async () => 'recovered')).toBe('recovered');
});

it('drops a key that was invalidated while its load was in flight', async () => {
  const time = clock();
  const cache = createAccessCache<string, string>({ ttlMs: 1000, now: time.now });
  let settle: (value: string) => void = () => {};
  const inFlight = cache.resolve('a', () => new Promise<string>((resolve) => { settle = resolve; }));

  // Permission changed mid-load: the answer in flight is already stale.
  cache.invalidate('a');
  settle('stale');
  expect(await inFlight).toBe('stale');

  expect(await cache.resolve('a', async () => 'fresh')).toBe('fresh');
});
