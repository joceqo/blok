import { createHash, randomBytes, randomInt } from 'node:crypto';

const CODE_DIGITS = 6;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const AUTH_CHALLENGE_RATE_LIMIT_MAX = 5;
export const AUTH_CHALLENGE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length > 3 && email.length <= 320 && email.includes('@') && !/\s/.test(email);
}

export function generateLoginCode(): string {
  const max = 10 ** CODE_DIGITS;
  return String(randomInt(0, max)).padStart(CODE_DIGITS, '0');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function challengeExpiresAt(now = Date.now()): Date {
  return new Date(now + CHALLENGE_TTL_MS);
}

/** Start of the rolling window for per-email challenge rate limits. */
export function authChallengeRateLimitWindowStart(now = Date.now()): Date {
  return new Date(now - AUTH_CHALLENGE_RATE_LIMIT_WINDOW_MS);
}

export function isAuthChallengeRateLimited(
  recentCount: number,
  max = AUTH_CHALLENGE_RATE_LIMIT_MAX,
): boolean {
  return recentCount >= max;
}

export function sessionExpiresAt(now = Date.now()): Date {
  return new Date(now + SESSION_TTL_MS);
}

/** Extend session expiry when more than half the standard session TTL remains; otherwise leave unchanged. */
export function sessionRefreshExpiresAt(
  currentExpiresAt: Date,
  now = Date.now(),
): Date | undefined {
  const remainingMs = currentExpiresAt.getTime() - now;
  if (remainingMs <= SESSION_TTL_MS / 2) {
    return undefined;
  }
  return sessionExpiresAt(now);
}

export const SESSION_COOKIE = 'blok_session';