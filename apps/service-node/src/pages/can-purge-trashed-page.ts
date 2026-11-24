import { canWorkspaceRole, type WorkspaceRole } from '@/permissions.js';

export type CanPurgeTrashedPageInput = {
  actorRole: WorkspaceRole;
  trashed: boolean;
};

export type CanPurgeTrashedPageFailure = 'permission_denied' | 'not_trashed';

export function canPurgeTrashedPage(
  input: CanPurgeTrashedPageInput,
): { ok: true } | { ok: false; reason: CanPurgeTrashedPageFailure } {
  if (!canWorkspaceRole(input.actorRole, 'delete')) {
    return { ok: false, reason: 'permission_denied' };
  }

  if (!input.trashed) {
    return { ok: false, reason: 'not_trashed' };
  }

  return { ok: true };
}