import { describe, expect, it } from 'vitest';

import {
  AUTH_CHALLENGE_RATE_LIMIT_WINDOW_MS,
  authChallengeRateLimitWindowStart,
  generateLoginCode,
  hashSecret,
  isAuthChallengeRateLimited,
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

  describe('authChallengeRateLimitWindowStart', () => {
    it('is 15 minutes before now', () => {
      const now = Date.UTC(2025, 5, 1, 12, 0, 0);
      expect(authChallengeRateLimitWindowStart(now)).toEqual(
        new Date(now - AUTH_CHALLENGE_RATE_LIMIT_WINDOW_MS),
      );
    });
  });

  describe('isAuthChallengeRateLimited', () => {
    it('allows fewer than five recent challenges', () => {
      expect(isAuthChallengeRateLimited(0)).toBe(false);
      expect(isAuthChallengeRateLimited(4)).toBe(false);
    });

    it('blocks at five or more recent challenges', () => {
      expect(isAuthChallengeRateLimited(5)).toBe(true);
      expect(isAuthChallengeRateLimited(6)).toBe(true);
    });
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