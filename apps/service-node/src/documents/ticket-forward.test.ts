import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyBlokTicket } from '../tickets/hmac.ts';
import { mintDocumentStateAuthorization } from './ticket-forward.ts';

const SECRET = 'test-secret-at-least-32-characters!';

afterEach(() => {
  vi.useRealTimers();
});

describe('mintDocumentStateAuthorization', () => {
  it('returns undefined without BLOK_SECRET', () => {
    const prior = process.env.BLOK_SECRET;
    delete process.env.BLOK_SECRET;
    try {
      expect(mintDocumentStateAuthorization('user-1', 'doc-abc')).toBeUndefined();
    } finally {
      if (prior !== undefined) {
        process.env.BLOK_SECRET = prior;
      }
    }
  });

  it('mints a read-only Bearer ticket for the doc', () => {
    process.env.BLOK_SECRET = SECRET;
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const header = mintDocumentStateAuthorization('user-1', 'doc-abc');
    expect(header?.startsWith('Bearer ')).toBe(true);

    const token = header?.slice('Bearer '.length);
    expect(token).toBeDefined();
    const claims = verifyBlokTicket(SECRET, token ?? '');
    expect(claims).toEqual({
      user: 'user-1',
      doc: 'doc-abc',
      write: false,
      exp: Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000) + 300,
    });
  });
});