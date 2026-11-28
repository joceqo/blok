import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../db/index.ts';
import { users, workspaceMembers, workspaces } from '../db/schema.ts';
import type { WorkspaceRole } from '../permissions.ts';

const ROLES: WorkspaceRole[] = ['owner', 'admin', 'member', 'guest'];

export function parseWorkspaceRole(value: string): WorkspaceRole | undefined {
  if (ROLES.includes(value as WorkspaceRole)) {
    return value as WorkspaceRole;
  }
  return undefined;
}

export async function memberRole(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | undefined> {
  const row = (
    await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)))
      .limit(1)
  )[0];
  if (row === undefined) {
    return undefined;
  }
  return parseWorkspaceRole(row.role);
}

export async function isMember(db: Database, userId: string, workspaceId: string): Promise<boolean> {
  return (await memberRole(db, userId, workspaceId)) !== undefined;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  role: WorkspaceRole;
}

export async function listWorkspacesForUser(db: Database, userId: string): Promise<WorkspaceRow[]> {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.name));

  const out: WorkspaceRow[] = [];
  for (const row of rows) {
    const role = parseWorkspaceRole(row.role);
    if (role === undefined) {
      continue;
    }
    out.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.createdAt,
      role,
    });
  }
  return out;
}

export async function memberRows(db: Database, workspaceId: string) {
  return db
    .select({
      userId: workspaceMembers.userId,
      email: users.email,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
}