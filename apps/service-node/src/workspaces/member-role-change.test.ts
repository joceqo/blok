import { describe, expect, it } from 'vitest';

import { validateMemberRoleChange } from './member-role-change.ts';

describe('validateMemberRoleChange', () => {
  it('allows owner to promote a member', () => {
    expect(
      validateMemberRoleChange({
        actorRole: 'owner',
        targetRole: 'member',
        nextRole: 'admin',
        ownerCount: 1,
      }),
    ).toEqual({ ok: true });
  });

  it('blocks non-owners from creating an owner', () => {
    expect(
      validateMemberRoleChange({
        actorRole: 'admin',
        targetRole: 'member',
        nextRole: 'owner',
        ownerCount: 2,
      }).ok,
    ).toBe(false);
  });

  it('blocks demoting the last owner', () => {
    const result = validateMemberRoleChange({
      actorRole: 'owner',
      targetRole: 'owner',
      nextRole: 'admin',
      ownerCount: 1,
    });
    expect(result).toEqual({ ok: false, reason: 'last_owner' });
  });

  it('blocks admins from retargeting an owner', () => {
    const result = validateMemberRoleChange({
      actorRole: 'admin',
      targetRole: 'owner',
      nextRole: 'admin',
      ownerCount: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'cannot_change_owner' });
  });
});