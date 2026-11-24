import { canWorkspaceRole } from '@/permissions.js';
import { parseWorkspaceRole } from '@/workspaces/membership.js';

export type PageCollaboratorRow = {
  userId: string;
  email: string;
  role: string;
};

export type PageCollaborator = {
  userId: string;
  email: string;
};

/** Workspace members who may read pages in the workspace (page read is workspace-scoped). */
export function pageReadCollaborators(rows: PageCollaboratorRow[]): PageCollaborator[] {
  const out: PageCollaborator[] = [];
  for (const row of rows) {
    const role = parseWorkspaceRole(row.role);
    if (role === undefined || !canWorkspaceRole(role, 'read')) {
      continue;
    }
    out.push({ userId: row.userId, email: row.email });
  }
  out.sort((a, b) => a.email.localeCompare(b.email));
  return out;
}