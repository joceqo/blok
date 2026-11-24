import { describe, expect, it } from 'vitest';

import { canLeaveWorkspace } from '@/workspaces/can-leave-workspace.js';

describe('canLeaveWorkspace', () => {
  it('allows non-owners to leave', () => {
    expect(
      canLeaveWorkspace({
        memberRole: 'member',
        ownerCount: 1,
      }),
    ).toEqual({ ok: true });

    expect(
      canLeaveWorkspace({
        memberRole: 'admin',
        ownerCount: 1,
      }),
    ).toEqual({ ok: true });

    expect(
      canLeaveWorkspace({
        memberRole: 'guest',
        ownerCount: 1,
      }),
    ).toEqual({ ok: true });
  });

  it('allows an owner to leave when another owner exists', () => {
    expect(
      canLeaveWorkspace({
        memberRole: 'owner',
        ownerCount: 2,
      }),
    ).toEqual({ ok: true });
  });

  it('blocks the last owner from leaving', () => {
    expect(
      canLeaveWorkspace({
        memberRole: 'owner',
        ownerCount: 1,
      }),
    ).toEqual({ ok: false, reason: 'last_owner' });
  });
});