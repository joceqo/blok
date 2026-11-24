import { describe, expect, it } from 'vitest';

import { filterPendingWorkspaceInvites, isPendingWorkspaceInvite } from '@/workspaces/invite-list.js';

describe('isPendingWorkspaceInvite', () => {
  it('is true when acceptedAt is null', () => {
    expect(isPendingWorkspaceInvite({ acceptedAt: null })).toBe(true);
  });

  it('is false when acceptedAt is set', () => {
    expect(isPendingWorkspaceInvite({ acceptedAt: new Date('2026-01-01') })).toBe(false);
  });
});

describe('filterPendingWorkspaceInvites', () => {
  it('keeps only pending rows', () => {
    const rows = [
      { id: 'a', acceptedAt: null },
      { id: 'b', acceptedAt: new Date('2026-01-02') },
      { id: 'c', acceptedAt: null },
    ];

    expect(filterPendingWorkspaceInvites(rows)).toEqual([
      { id: 'a', acceptedAt: null },
      { id: 'c', acceptedAt: null },
    ]);
  });
});