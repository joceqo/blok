import type { Context } from 'hono';

import type { Database } from '../db/index.js';
import { WorkspaceNotFoundError } from '../errors.js';
import { assertPageAction, PermissionDeniedError, type WorkspaceRole } from '../permissions.js';
import { memberRole } from '../workspaces/membership.js';

export async function roleInWorkspace(
  db: Database,
  context: Context,
  workspaceId: string,
): Promise<WorkspaceRole | undefined> {
  const userId = context.get('userId');
  if (userId === undefined) {
    return undefined;
  }
  return memberRole(db, userId, workspaceId);
}

export async function requireWorkspaceRole(
  db: Database,
  context: Context,
  workspaceId: string,
  action: Parameters<typeof assertPageAction>[1],
): Promise<WorkspaceRole> {
  const role = await roleInWorkspace(db, context, workspaceId);
  if (role === undefined) {
    throw new WorkspaceNotFoundError();
  }
  assertPageAction(role, action);
  return role;
}