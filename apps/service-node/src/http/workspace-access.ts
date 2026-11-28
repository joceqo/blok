import type { Context } from 'hono';

import type { Database } from '../db/index.ts';
import { WorkspaceNotFoundError } from '../errors.ts';
import { assertPageAction, PermissionDeniedError, type WorkspaceRole } from '../permissions.ts';
import { memberRole } from '../workspaces/membership.ts';

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