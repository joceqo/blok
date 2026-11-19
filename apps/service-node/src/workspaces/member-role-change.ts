import type { WorkspaceRole } from '@/permissions.js';

export type MemberRoleChangeInput = {
  actorRole: WorkspaceRole;
  targetRole: WorkspaceRole;
  nextRole: WorkspaceRole;
  ownerCount: number;
};

export type MemberRoleChangeFailure =
  | 'cannot_assign_owner'
  | 'cannot_change_owner'
  | 'last_owner';

export function validateMemberRoleChange(
  input: MemberRoleChangeInput,
): { ok: true } | { ok: false; reason: MemberRoleChangeFailure } {
  const { actorRole, targetRole, nextRole, ownerCount } = input;

  if (nextRole === 'owner' && actorRole !== 'owner') {
    return { ok: false, reason: 'cannot_assign_owner' };
  }

  if (targetRole === 'owner' && actorRole !== 'owner' && actorRole !== 'admin') {
    return { ok: false, reason: 'cannot_change_owner' };
  }

  if (targetRole === 'owner' && nextRole !== 'owner' && ownerCount <= 1) {
    return { ok: false, reason: 'last_owner' };
  }

  if (actorRole === 'admin' && targetRole === 'owner') {
    return { ok: false, reason: 'cannot_change_owner' };
  }

  if (actorRole !== 'owner' && actorRole !== 'admin') {
    return { ok: false, reason: 'cannot_change_owner' };
  }

  return { ok: true };
}