import { describe, expect, it } from 'vitest';

import { assertPageAction, canWorkspaceRole } from './permissions.ts';

describe('permissions', () => {
  it('lets members edit but not delete pages', () => {
    expect(canWorkspaceRole('member', 'edit')).toBe(true);
    expect(canWorkspaceRole('member', 'delete')).toBe(false);
  });

  it('throws when asserting a forbidden action', () => {
    expect(() => assertPageAction('guest', 'delete')).toThrow(/permission denied/);
  });
});