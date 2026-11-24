import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.js';
import { levels, resolvePageLevel, type Level, type Visibility } from './page-level.js';
import { WorkspaceError, readWorkspaceScope } from './workspace-scope.js';
import { sessionDigest } from './session.js';

type PageVisibility = Visibility | 'inherit';
type Mutation =
  | { action: 'visibility'; visibility: PageVisibility }
  | { action: 'grant'; target: string; level: Level }
  | { action: 'revoke'; target: string };
interface Ancestor { id: string; visibility: PageVisibility; share: Level | null }
interface Entry { userId: string; email: string; level: Level; from: string }

async function editRequest(c: Context): Promise<Mutation> {
  const target = c.req.param('target');
  if (c.req.method === 'DELETE') return { action: 'revoke', target: target! };
  let input: unknown;
  try { input = await c.req.json(); }
  catch { throw new WorkspaceError(400, 'Invalid JSON'); }
  if (input !== null && (typeof input !== 'object' || Array.isArray(input))) throw new WorkspaceError(400, 'Invalid JSON');
  if (target !== undefined) {
    const level = (input as { level?: Level } | null)?.level;
    if (!level || !levels.includes(level)) throw new WorkspaceError(400, 'Invalid level');
    return { action: 'grant', target, level };
  }
  const visibility = (input as { visibility?: unknown } | null)?.visibility;
  if (visibility !== 'workspace' && visibility !== 'private' && visibility !== 'inherit') {
    throw new WorkspaceError(400, 'Invalid visibility');
  }
  return { action: 'visibility', visibility };
}

async function ancestors(client: PoolClient, workspace: string, page: string, user: string) {
  const { rows } = await client.query<Ancestor>(
    `WITH RECURSIVE chain AS (
       SELECT id,visibility,metadata->>'parentId' AS parent,0 AS depth FROM pages
       WHERE id=$1 AND workspace_id=$2 AND NOT deleted
       UNION ALL
       SELECT p.id,p.visibility,p.metadata->>'parentId',c.depth+1
       FROM pages p JOIN chain c ON p.id=c.parent
       WHERE p.workspace_id=$2 AND NOT p.deleted AND c.depth+1<64)
     SELECT c.id,c.visibility,s.level AS share FROM chain c
     LEFT JOIN page_shares s ON s.page_id=c.id AND s.user_id=$3 ORDER BY c.depth`, [page, workspace, user],
  );
  return rows;
}

async function accessSheet(client: PoolClient, chain: Ancestor[], effectiveVisibility: Visibility, myLevel: Level) {
  const { rows } = await client.query<Entry>(
    `SELECT s.page_id AS "from",u.id AS "userId",u.email,s.level FROM page_shares s
       JOIN users u ON u.id=s.user_id WHERE s.page_id=ANY($1) ORDER BY u.email,s.page_id`, [chain.map(p => p.id)],
  );
  const page = chain[0]!;
  return {
    visibility: page.visibility, effectiveVisibility, myLevel,
    shares: rows.filter(r => r.from === page.id).map(({ from, ...share }) => share),
    inherited: rows.filter(r => r.from !== page.id),
  };
}

async function applyMutation(client: PoolClient, workspace: string, page: string, user: string, mutation: Mutation) {
  switch (mutation.action) {
    case 'visibility':
      await client.query('UPDATE pages SET visibility=$3 WHERE id=$1 AND workspace_id=$2', [page, workspace, mutation.visibility]);
      return;
    case 'revoke':
      await client.query('DELETE FROM page_shares WHERE page_id=$1 AND user_id=$2', [page, mutation.target]);
      return;
    case 'grant': {
      const member = await client.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspace, mutation.target]);
      if (!member.rowCount) throw new WorkspaceError(404, 'Member not found');
      await client.query(
        `INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,$2,$3,$4)
         ON CONFLICT(page_id,user_id) DO UPDATE SET level=excluded.level,granted_by=excluded.granted_by`,
        [page, mutation.target, mutation.level, user],
      );
    }
  }
}

function visibilityOf(chain: Ancestor[]): Visibility {
  for (const page of chain) {
    if (page.visibility !== 'inherit') return page.visibility;
  }
  return 'private';
}

async function ensureManager(client: PoolClient, workspace: string, chain: Ancestor[]) {
  if (visibilityOf(chain) === 'workspace') return;
  const remaining = await client.query(
    `SELECT 1 FROM page_shares s JOIN memberships m ON m.user_id=s.user_id AND m.workspace_id=$1
     WHERE s.page_id=ANY($2) AND s.level='full' AND m.role IN ('admin','member')
     ORDER BY m.user_id LIMIT 1 FOR SHARE OF m`, [workspace, chain.map(p => p.id)],
  );
  if (!remaining.rowCount) throw new WorkspaceError(409, 'Keep at least one full access on a private page');
}

export function createPageSharing(pool: PgPool, recheckAccess: (workspaceId: string) => Promise<void>) {
  const router = new Hono();
  router.onError((err, c) => {
    if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
    throw err;
  });
  router.use('*', bodyLimit({ maxSize: 8 << 20, onError: c => c.json({ error: 'Invalid JSON' }, 400) }));
  async function handle(c: Context) {
    const key = sessionDigest(c);
    if (!key) throw new WorkspaceError(401, 'Sign in required');
    const write = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    // Consume the input before locking the workspace. Surface validation errors
    // after permission checks so protected pages stay indistinguishable.
    const mutation = write ? await editRequest(c).catch((err: unknown) => {
      if (err instanceof WorkspaceError) return err;
      throw err;
    }) : undefined;
    const page = c.req.param('id')!;
    const client = await pool.connect();
    let workspace: string;
    try {
      await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scope = await readWorkspaceScope(client, key, c.req.param('slug')!, write);
      workspace = scope.workspace_id;
      const chain = await ancestors(client, workspace, page, scope.user_id);
      const effectiveVisibility = visibilityOf(chain);
      const best = Math.max(-1, ...chain.map(p => p.share ? levels.indexOf(p.share) : -1));
      const level = chain.length && resolvePageLevel(scope.role, effectiveVisibility, best);
      if (!level) throw new WorkspaceError(404, 'Page not found');
      if (mutation === undefined) {
        const sheet = await accessSheet(client, chain, effectiveVisibility, level);
        await client.query('COMMIT');
        return c.json(sheet);
      }
      if (level !== 'full') throw new WorkspaceError(403, 'Full access required');
      if (mutation instanceof WorkspaceError) throw mutation;
      await applyMutation(client, workspace, page, scope.user_id, mutation);
      if (mutation.action === 'visibility') chain[0]!.visibility = mutation.visibility;
      await ensureManager(client, workspace, chain);
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
      return c.json({ error: 'Sharing saved, live access refresh failed' }, 503);
    }
    return c.json({ ok: true });
  }
  router.on(['GET', 'PUT'], '/:id/access', handle);
  router.on(['PUT', 'DELETE'], '/:id/shares/:target', handle);
  return router;
}
