import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';
import type { Role } from './page-level.ts';
import { sessionDigest } from './session.ts';
import { WorkspaceError, readWorkspaceScope } from './workspace-scope.ts';

function parseRole(body: unknown): Role {
  const role = body && typeof body === 'object' && 'role' in body && body.role;
  if (role === 'admin' || role === 'member' || role === 'viewer') return role;
  throw new WorkspaceError(400, 'Invalid role');
}

async function changeMember(client: PoolClient, workspace: string, target: string, role: Role | null) {
  const { rows: [member] } = await client.query<{ role: Role }>(
    'SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [workspace, target]);
  if (!member) throw new WorkspaceError(404, 'Member not found');
  if (member.role === 'admin' && role !== 'admin') {
    const { rowCount } = await client.query(
      "SELECT 1 FROM memberships WHERE workspace_id=$1 AND role='admin' AND user_id<>$2 LIMIT 1", [workspace, target]);
    if (!rowCount) throw new WorkspaceError(409, 'Keep at least one administrator');
  }
  if (role !== null) {
    await client.query('UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2', [workspace, target, role]);
    return;
  }
  // Leaving and later rejoining must not restore named page grants.
  await client.query(`DELETE FROM page_shares sh USING pages p
    WHERE sh.page_id=p.id AND p.workspace_id=$1 AND sh.user_id=$2`, [workspace, target]);
  await client.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspace, target]);
}

export function createWorkspaceMembers(pool: PgPool, recheckAccess: (workspace: string) => Promise<void>) {
  const router = new Hono();
  router.onError((error, c) => {
    if (error instanceof WorkspaceError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  router.use('*', bodyLimit({ maxSize: 8 << 20, onError: c => c.json({ error: 'Invalid JSON' }, 400) }));
  async function handle(c: Context) {
    const key = sessionDigest(c);
    if (!key) throw new WorkspaceError(401, 'Sign in required');
    const write = c.req.method === 'PATCH' || c.req.method === 'DELETE';
    const body: unknown = c.req.method === 'PATCH' ? await c.req.json().catch(() => null) : null;
    const client = await pool.connect();
    let workspace: string;
    try {
      await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scope = await readWorkspaceScope(client, key, c.req.param('slug')!, write);
      workspace = scope.workspace_id;
      if (!write) {
        const { rows } = await client.query(`SELECT u.id,u.email,m.role FROM memberships m
          JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.email`, [workspace]);
        await client.query('COMMIT');
        return c.json({ members: rows });
      }
      if (scope.role !== 'admin') throw new WorkspaceError(403, 'Administrator required');
      await changeMember(client, workspace, c.req.param('userId')!, c.req.method === 'DELETE' ? null : parseRole(body));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    try {
      await recheckAccess(workspace);
    } catch {
      return c.json({ error: 'Membership saved, live access refresh failed' }, 503);
    }
    return c.json({ ok: true });
  }
  router.get('/', handle);
  router.on(['PATCH', 'DELETE'], '/:userId', handle);
  return router;
}
