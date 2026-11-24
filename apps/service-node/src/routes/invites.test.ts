import { describe, expect, it } from 'vitest';

import { filterPendingWorkspaceInvites } from '../workspaces/invite-list.ts';

describe('workspace invite list (pending filter)', () => {
  it('matches GET /api/workspaces/:id/invites semantics (pending only)', () => {
    const pending = {
      id: 'inv-1',
      workspaceId: 'ws-1',
      email: 'a@example.com',
      role: 'read',
      invitedBy: 'user-1',
      createdAt: new Date('2026-03-01'),
      acceptedAt: null,
    };
    const accepted = { ...pending, id: 'inv-2', acceptedAt: new Date('2026-03-02') };

    expect(filterPendingWorkspaceInvites([pending, accepted])).toEqual([pending]);
  });
});