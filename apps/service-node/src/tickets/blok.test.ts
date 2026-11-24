import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadTicketsConformanceFixture } from '../testing/tickets-fixture.ts';
import { blokTicket } from './blok.ts';

const fixtures = loadTicketsConformanceFixture();

afterEach(() => {
  vi.useRealTimers();
});

describe('blokTicket (shared with @bloklabs/server)', () => {
  it('matches the conformance fixtures compatible token', () => {
    const exp = 4_102_444_800;
    vi.useFakeTimers().setSystemTime(new Date((exp - 300) * 1000));

    const token = blokTicket(fixtures.secret, {
      user: 'u1',
      doc: 'doc-42',
      write: true,
      ttlSeconds: 300,
    });

    expect(token).toBe(fixtures.compatible);
  });
});