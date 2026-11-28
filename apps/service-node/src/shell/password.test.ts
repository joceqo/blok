import { describe, expect, it } from 'vitest';
import { hashPassword, validPassword, verifyPassword } from './password.ts';

describe('local passwords', () => {
  it('validates lengths in Unicode characters and storage bytes', () => {
    expect(validPassword('🪐'.repeat(11))).toBe(false);
    expect(validPassword('🪐'.repeat(12))).toBe(true);
    expect(validPassword('🪐'.repeat(257))).toBe(false);
  });
  it('uses independent salts, preserves whitespace and rejects missing credentials', async () => {
    const password = ' un exemple long ';
    const first = await hashPassword(password);
    expect(await hashPassword(password)).not.toBe(first);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(password.trim(), first)).toBe(false);
    expect(await verifyPassword(password, null)).toBe(false);
  });
});
