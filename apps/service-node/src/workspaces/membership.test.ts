import { describe, expect, it } from 'vitest';

import { parseWorkspaceRole } from './membership.ts';

describe('parseWorkspaceRole', () => {
  it('accepts known roles', () => {
    expect(parseWorkspaceRole('owner')).toBe('owner');
    expect(parseWorkspaceRole('guest')).toBe('guest');
  });

  it('rejects unknown', () => {
    expect(parseWorkspaceRole('superuser')).toBeUndefined();
  });
});