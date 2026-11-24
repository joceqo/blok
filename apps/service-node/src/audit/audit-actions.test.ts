import { describe, expect, it } from 'vitest';

import { formatAuditAction } from './audit-actions.ts';

describe('formatAuditAction', () => {
  it('maps workspace delete', () => {
    expect(formatAuditAction({ kind: 'workspace_delete' })).toBe('workspace.delete');
  });

  it('maps workspace ownership transfer', () => {
    expect(formatAuditAction({ kind: 'workspace_transfer_ownership' })).toBe(
      'workspace.transfer_ownership',
    );
  });
});