import { describe, expect, it } from 'vitest';

import { generateLoginCode, hashSecret, isValidEmail, normalizeEmail } from './codes.js';

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
});