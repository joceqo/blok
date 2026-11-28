import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgPool } from '../db/pool.ts';
import { IndexError, parseIndex, planIndexSave } from './index-save.ts';
import { sessionDigest } from './session.ts';
import { loadIndexPages, type Role } from './workspace-index.ts';

async function saveIndex(pool: PgPool, key: string, slug: string, body: unknown) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const { rows: [session] } = await client.query<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE id=$1 AND expires_at>now() FOR SHARE', [key]);
    if (!session) throw new IndexError(401, 'Sign in required');
    const { rows: [workspace] } = await client.query<{ id: string; revision: string }>(
      `SELECT id, revision::text FROM workspaces WHERE slug=$1 OR id=$1
       ORDER BY (slug=$1) DESC LIMIT 1 FOR UPDATE`, [slug]);
    if (!workspace) throw new IndexError(404, 'Workspace not found');
    const { rows: [member] } = await client.query<{role: Role}>(
      'SELECT role FROM memberships WHERE user_id=$1 AND workspace_id=$2 FOR SHARE', [session.user_id, workspace.id]);
    if (!member) throw new IndexError(403, 'Workspace membership required');
    if (member.role === 'viewer') throw new IndexError(403, 'Write access required');
    const { revision, incoming } = parseIndex(body);
    if (String(revision) !== workspace.revision) throw new IndexError(409, 'Workspace changed; reload before saving');
    if (!Number.isSafeInteger(revision + 1)) throw new Error('Workspace revision overflow');

    const pages = await loadIndexPages(client, workspace.id, session.user_id);
    const { fixed, updates, creations, removed } = planIndexSave(pages, member.role, incoming);
    await client.query('UPDATE pages SET deleted=true WHERE workspace_id=$1 AND id=ANY($2::text[])', [workspace.id, removed]);
    await client.query(`UPDATE pages p SET metadata=jsonb_set(p.metadata,'{position}',to_jsonb(s.position))
      FROM jsonb_to_recordset($2::jsonb) s(id text,position int)
      WHERE p.workspace_id=$1 AND p.id=s.id AND NOT p.deleted
        AND p.metadata->'position' IS DISTINCT FROM to_jsonb(s.position)`, [workspace.id, JSON.stringify(fixed)]);
    await client.query(`UPDATE pages p SET metadata=s.metadata, trashed=s.trashed
      FROM jsonb_to_recordset($2::jsonb) s(id text,metadata jsonb,trashed boolean)
      WHERE p.workspace_id=$1 AND p.id=s.id AND NOT p.deleted
        AND (p.metadata,p.trashed) IS DISTINCT FROM (s.metadata,s.trashed)`, [workspace.id, JSON.stringify(updates)]);
    // Reserve a global ID exactly once. A tombstone or a page in another
    // workspace cannot be resurrected and claimed through the index.
    const inserted = await client.query(`INSERT INTO pages(id,workspace_id,metadata,trashed,visibility)
      SELECT s.id,$1,s.metadata,s.trashed,s.visibility
      FROM jsonb_to_recordset($2::jsonb) s(id text,metadata jsonb,trashed boolean,visibility text)
      ON CONFLICT(id) DO NOTHING`, [workspace.id, JSON.stringify(creations)]);
    if (inserted.rowCount !== creations.length) throw new IndexError(409, 'Page ID already in use');
    await client.query(`INSERT INTO page_shares(page_id,user_id,level,granted_by)
      SELECT id,$1,'full',$1 FROM unnest($2::text[]) AS pages(id)`,
      [session.user_id, creations.map(p => p.id)]);
    await client.query('UPDATE workspaces SET revision=revision+1 WHERE id=$1', [workspace.id]);
    await client.query('COMMIT');
    return { workspaceId: workspace.id, revision: revision + 1 };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && (error.code === '40001' || error.code === '40P01')) {
      throw new IndexError(409, 'Workspace changed; reload before saving');
    }
    throw error;
  } finally {
    client.release();
  }
}

export function registerIndexWrite(app: Hono, pool: PgPool, recheckAccess?: (workspaceId: string) => Promise<void>) {
  app.put('/api/workspaces/:slug/index', bodyLimit({
    maxSize: 8 << 20, onError: c => c.json({ error: 'Invalid JSON' }, 400),
  }), async c => {
    const key = sessionDigest(c);
    if (!key) return c.json({ error: 'Sign in required' }, 401);
    if (!recheckAccess) return c.json({ error: 'Collaboration access recheck unavailable' }, 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    let written;
    try {
      written = await saveIndex(pool, key, c.req.param('slug'), body);
    } catch (error) {
      if (error instanceof IndexError) return c.json({ error: error.message }, error.status);
      throw error;
    }
    try {
      await recheckAccess(written.workspaceId);
    } catch {
      return c.json({ error: 'Index saved, live access refresh failed', revision: written.revision }, 503);
    }
    return c.json({ revision: written.revision });
  });
}
