import type { WorkspaceRole } from '@/permissions.js';

export type OwnershipTransferInput = {
  actorRole: WorkspaceRole;
  targetRole: WorkspaceRole;
  actorUserId: string;
  targetUserId: string;
};

export type OwnershipTransferFailure =
  | 'permission_denied'
  | 'invalid_target'
  | 'cannot_transfer_to_self';

export function validateOwnershipTransfer(
  input: OwnershipTransferInput,
): { ok: true } | { ok: false; reason: OwnershipTransferFailure } {
  if (input.actorRole !== 'owner') {
    return { ok: false, reason: 'permission_denied' };
  }

  if (input.actorUserId === input.targetUserId) {
    return { ok: false, reason: 'cannot_transfer_to_self' };
  }

  if (input.targetRole !== 'admin' && input.targetRole !== 'member') {
    return { ok: false, reason: 'invalid_target' };
  }

  return { ok: true };
}