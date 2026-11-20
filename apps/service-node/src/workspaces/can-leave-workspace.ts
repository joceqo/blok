import type { WorkspaceRole } from '@/permissions.js';

export type CanLeaveWorkspaceInput = {
  memberRole: WorkspaceRole;
  ownerCount: number;
};

export type CanLeaveWorkspaceFailure = 'last_owner';

export function canLeaveWorkspace(
  input: CanLeaveWorkspaceInput,
): { ok: true } | { ok: false; reason: CanLeaveWorkspaceFailure } {
  if (input.memberRole === 'owner' && input.ownerCount <= 1) {
    return { ok: false, reason: 'last_owner' };
  }

  return { ok: true };
}