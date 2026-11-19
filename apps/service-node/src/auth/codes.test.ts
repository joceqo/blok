import { describe, expect, it } from 'vitest';

import {
  generateLoginCode,
  hashSecret,
  isValidEmail,
  normalizeEmail,
  sessionExpiresAt,
  sessionRefreshExpiresAt,
} from './codes.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

describe('auth codes', () => {
  it('normalizes email', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });

  it('validates email roughly', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('bad')).toBe(false);
  });

  it('generates fixed-width numeric codes', () => {
    expect(generateLoginCode()).toMatch(/^\d{6}$/);
  });

  it('hashes consistently', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'));
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'));
  });

  describe('sessionRefreshExpiresAt', () => {
    const now = Date.UTC(2025, 0, 1, 12, 0, 0);

    it('extends to 30d from now when more than half the session TTL remains', () => {
      const currentExpiresAt = new Date(now + SESSION_TTL_MS * 0.5 + 1);
      expect(sessionRefreshExpiresAt(currentExpiresAt, now)).toEqual(sessionExpiresAt(now));
    });

    it('does not extend when at most half the session TTL remains', () => {
      const atHalf = new Date(now + SESSION_TTL_MS * 0.5);
      const belowHalf = new Date(now + SESSION_TTL_MS * 0.25);
      expect(sessionRefreshExpiresAt(atHalf, now)).toBeUndefined();
      expect(sessionRefreshExpiresAt(belowHalf, now)).toBeUndefined();
    });
  });
});