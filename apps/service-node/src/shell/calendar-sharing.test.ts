import { describe, expect, it } from 'vitest';
import { busyWithin } from './calendar-sharing.ts';

const instant = (hour: number): string => new Date(Date.UTC(2026, 10, 25, hour)).toISOString();

describe('member availability', () => {
  it('clips, merges and strips identifiers and event details from the response', () => {
    const data = [
      { start: instant(11), end: instant(15), title: 'Private', id: 'abc' },
      { start: instant(9), end: instant(11) },
      { start: instant(16), end: instant(19) },
      { start: instant(4), end: instant(8) },
    ];
    expect(busyWithin(data, instant(10), instant(17))).toEqual([
      { start: instant(10), end: instant(15) },
      { start: instant(16), end: instant(17) },
    ]);
  });
  it('reports an unavailable provider when its response contains malformed intervals', () => {
    expect(() => busyWithin([{ start: 'bad', end: instant(12) }], instant(10), instant(18))).toThrow('indisponibles');
  });
});
