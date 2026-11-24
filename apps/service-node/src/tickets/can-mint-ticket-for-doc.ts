import { canWorkspaceRole, type WorkspaceRole } from '../permissions.ts';

export type CanMintTicketForDocInput = {
  hasBinding: boolean;
  role: WorkspaceRole | undefined;
  write?: boolean;
};

export type CanMintTicketForDocFailure = 'doc_not_bound' | 'not_found' | 'permission_denied';

export type CanMintTicketForDocResult =
  | { ok: true }
  | { ok: false; reason: CanMintTicketForDocFailure };

/**
 * Pure gate for POST /api/tickets/blok when the body names a collaboration doc id.
 */
export function canMintTicketForDoc(input: CanMintTicketForDocInput): CanMintTicketForDocResult {
  if (!input.hasBinding) {
    return { ok: false, reason: 'doc_not_bound' };
  }

  if (input.role === undefined) {
    return { ok: false, reason: 'not_found' };
  }

  const action = input.write === true ? 'edit' : 'read';
  if (!canWorkspaceRole(input.role, action)) {
    return { ok: false, reason: 'permission_denied' };
  }

  return { ok: true };
}