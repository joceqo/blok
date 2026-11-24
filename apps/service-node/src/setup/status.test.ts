import { describe, expect, it } from 'vitest';

import { canRunFirstAdminSetup, needsSetup } from '@/setup/status.js';

describe('needsSetup', () => {
  it('is true when there are no users', () => {
    expect(needsSetup(0)).toBe(true);
  });

  it('is false when at least one user exists', () => {
    expect(needsSetup(1)).toBe(false);
    expect(needsSetup(42)).toBe(false);
  });
});

describe('canRunFirstAdminSetup', () => {
  it('allows setup with no token when user count is zero', () => {
    expect(canRunFirstAdminSetup(0, undefined, undefined)).toBe(true);
    expect(canRunFirstAdminSetup(0, 'secret', undefined)).toBe(true);
  });

  it('denies setup when users exist and SETUP_TOKEN is unset', () => {
    expect(canRunFirstAdminSetup(1, undefined, undefined)).toBe(false);
    expect(canRunFirstAdminSetup(1, '', undefined)).toBe(false);
  });

  it('allows setup when users exist and body token matches SETUP_TOKEN', () => {
    expect(canRunFirstAdminSetup(3, 'bootstrap-token', 'bootstrap-token')).toBe(true);
  });

  it('denies setup when body token does not match', () => {
    expect(canRunFirstAdminSetup(2, 'expected', 'wrong')).toBe(false);
    expect(canRunFirstAdminSetup(2, 'expected', undefined)).toBe(false);
  });
});