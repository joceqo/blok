import type { WorkspaceRole } from '../permissions.ts';

export type CanDeleteWorkspaceInput = {
  actorRole: WorkspaceRole;
  pageCount: number;
};

export type CanDeleteWorkspaceFailure = 'permission_denied' | 'has_content';

export function canDeleteWorkspace(
  input: CanDeleteWorkspaceInput,
): { ok: true } | { ok: false; reason: CanDeleteWorkspaceFailure } {
  if (input.actorRole !== 'owner') {
    return { ok: false, reason: 'permission_denied' };
  }

  if (input.pageCount > 0) {
    return { ok: false, reason: 'has_content' };
  }

  return { ok: true };
}