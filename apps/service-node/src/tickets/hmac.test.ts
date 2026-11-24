import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadTicketsConformanceFixture } from '../testing/tickets-fixture.ts';
import { blokTicket, verifyBlokTicket } from './hmac.ts';

const fixtures = loadTicketsConformanceFixture();
const SECRET = fixtures.secret;

afterEach(() => {
  vi.useRealTimers();
});

describe('blokTicket HMAC roundtrip', () => {
  it('matches the conformance compatible token', () => {
    const exp = 4_102_444_800;
    vi.useFakeTimers().setSystemTime(new Date((exp - 300) * 1000));

    const token = blokTicket(SECRET, {
      user: 'u1',
      doc: 'doc-42',
      write: true,
      ttlSeconds: 300,
    });

    expect(token).toBe(fixtures.compatible);
  });

  it('verifies a freshly minted token', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const token = blokTicket(SECRET, {
      user: 'u1',
      doc: 'doc-42',
      write: true,
      ttlSeconds: 300,
    });

    const claims = verifyBlokTicket(SECRET, token);
    expect(claims).toEqual({
      user: 'u1',
      doc: 'doc-42',
      write: true,
      exp: Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000) + 300,
    });
  });

  it('rejects a tampered signature', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const token = blokTicket(SECRET, { user: 'u1', doc: 'doc-42', write: true });
    const tampered = `${token.slice(0, -1)}a`;

    expect(() => verifyBlokTicket(SECRET, tampered)).toThrow(/invalid signature/);
  });
});