import type { PoolClient } from 'pg';
import type { Role } from './page-level.js';

export class WorkspaceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, message: string) { super(message); }
}

// Call inside a transaction. All membership, sharing and index changes lock
// the workspace before acting on its current roles.
export async function readWorkspaceScope(client: PoolClient, digest: string, slug: string, write: boolean) {
  const { rows: [session] } = await client.query<{ user_id: string }>(
    `SELECT user_id FROM sessions WHERE id=$1 AND expires_at>now() ${write ? 'FOR SHARE' : ''}`, [digest]);
  if (!session) throw new WorkspaceError(401, 'Sign in required');
  const { rows: [workspace] } = await client.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug=$1 OR id=$1 ORDER BY (slug=$1) DESC
     LIMIT 1 ${write ? 'FOR UPDATE' : ''}`, [slug]);
  if (!workspace) throw new WorkspaceError(404, 'Workspace not found');
  const { rows: [member] } = await client.query<{ role: Role }>(
    `SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 ${write ? 'FOR SHARE' : ''}`, [workspace.id, session.user_id]);
  if (!member) throw new WorkspaceError(403, 'Workspace membership required');
  return { user_id: session.user_id, workspace_id: workspace.id, role: member.role };
}
