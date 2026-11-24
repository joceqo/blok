/**
 * Pure permission matrix — port target for `apps/service/permissions.go` (lot 1).
 * No SQL here: handlers call these after loading membership rows.
 */

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';

export type PageAction =
  | 'read'
  | 'comment'
  | 'edit'
  | 'share'
  | 'move'
  | 'trash'
  | 'restore'
  | 'delete';

const ROLE_RANK: Record<WorkspaceRole, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/** Minimum role to perform an action on a page inside a workspace. */
const PAGE_ACTION_MIN_ROLE: Record<PageAction, WorkspaceRole> = {
  read: 'guest',
  comment: 'member',
  edit: 'member',
  share: 'admin',
  move: 'member',
  trash: 'admin',
  restore: 'admin',
  delete: 'owner',
};

export function canWorkspaceRole(
  role: WorkspaceRole,
  action: PageAction,
): boolean {
  const need = PAGE_ACTION_MIN_ROLE[action];
  return ROLE_RANK[role] >= ROLE_RANK[need];
}

export function assertPageAction(role: WorkspaceRole, action: PageAction): void {
  if (!canWorkspaceRole(role, action)) {
    throw new PermissionDeniedError(action, role);
  }
}

export class PermissionDeniedError extends Error {
  readonly action: PageAction;
  readonly role: WorkspaceRole;

  constructor(action: PageAction, role: WorkspaceRole) {
    super(`permission denied: ${action} requires higher than ${role}`);
    this.name = 'PermissionDeniedError';
    this.action = action;
    this.role = role;
  }
}