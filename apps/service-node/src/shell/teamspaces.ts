import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.js';
import { parseTeamspaceCreateBody, parseTeamspacePatchBody } from '../workspaces/teamspace-body.js';
import { sessionDigest } from './session.js';

interface Scope {
  client: PoolClient;
  workspaceId: string;
  input: unknown;
}

// The canonical shell uses URL-safe opaque user IDs, including existing UUIDs.
export function shellMemberId(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const id = value.trim();
  if (/^[a-z0-9_-]+$/i.test(id)) return id;
}

type Route = (c: Context, scope: Scope) => Promise<Response>;
const teamspaceFields = 'id,workspace_id AS "workspaceId",name,created_at AS "createdAt"';

export function createShellTeamspaces(pool: PgPool) {
  const router = new Hono();
  router.use('*', bodyLimit({ maxSize: 8 << 20, onError: c => c.json({ error: 'invalid_request' }, 400) }));

  // Hold the session and membership until the operation finishes. A concurrent
  // departure or demotion cannot race the authorization of an edit.
  const scoped = (route: Route) => async (c: Context) => {
    const digest = sessionDigest(c);
    if (!digest) return c.json({ error: 'unauthenticated' }, 401);
    const method = c.req.method;
    const input: unknown = method === 'POST' || method === 'PATCH' ? await c.req.json().catch(() => null) : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [scope] } = await client.query<{
        user_id: string | null; workspace_id: string | null; role: string | null;
      }>(
        `SELECT s.user_id,w.id AS workspace_id,m.role FROM (SELECT 1) request
         LEFT JOIN LATERAL (SELECT user_id FROM sessions WHERE id=$1 AND expires_at>now() FOR SHARE) s ON true
         LEFT JOIN LATERAL (SELECT id FROM workspaces WHERE slug=$2 OR id=$2 ORDER BY (slug=$2) DESC LIMIT 1 FOR KEY SHARE) w ON true
         LEFT JOIN LATERAL (SELECT role FROM memberships WHERE workspace_id=w.id AND user_id=s.user_id FOR SHARE) m ON true`,
        [digest, c.req.param('slug')],
      );
      let response: Response;
      if (!scope?.user_id) response = c.json({ error: 'unauthenticated' }, 401);
      else if (!scope.workspace_id || !scope.role) response = c.json({ error: 'not_found' }, 404);
      else if (method !== 'GET' && method !== 'HEAD' && scope.role !== 'admin' && scope.role !== 'member') {
        response = c.json({ error: 'permission_denied', action: 'edit' }, 403);
      } else {
        response = await route(c, { client, workspaceId: scope.workspace_id, input });
      }
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const inTeam = (route: Route) => scoped(async (c, scope) => {
    const team = await scope.client.query(
      'SELECT 1 FROM teamspaces WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE',
      [scope.workspaceId, c.req.param('teamspaceId')],
    );
    if (!team.rowCount) return c.json({ error: 'not_found' }, 404);
    return route(c, scope);
  });

  router.get('/', scoped(async (c, { client, workspaceId }) => {
    const { rows } = await client.query(`SELECT ${teamspaceFields} FROM teamspaces WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId]);
    return c.json({ teamspaces: rows });
  }));

  router.post('/', scoped(async (c, { client, workspaceId, input }) => {
    const parsed = parseTeamspaceCreateBody(input);
    if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
    const { rows } = await client.query(
      `INSERT INTO teamspaces(id,workspace_id,name) VALUES($1,$2,$3) RETURNING ${teamspaceFields}`,
      [randomUUID(), workspaceId, parsed.name],
    );
    return c.json({ teamspace: rows[0] }, 201);
  }));

  router.patch('/:teamspaceId', inTeam(async (c, { client, workspaceId, input }) => {
    const parsed = parseTeamspacePatchBody(input);
    if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
    const { rows } = await client.query(
      `UPDATE teamspaces SET name=$3 WHERE workspace_id=$1 AND id=$2 RETURNING ${teamspaceFields}`,
      [workspaceId, c.req.param('teamspaceId'), parsed.name],
    );
    return c.json({ teamspace: rows[0] });
  }));

  router.delete('/:teamspaceId', scoped(async (c, { client, workspaceId }) => {
    const removed = await client.query('DELETE FROM teamspaces WHERE workspace_id=$1 AND id=$2', [workspaceId, c.req.param('teamspaceId')]);
    if (!removed.rowCount) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  }));

  router.get('/:teamspaceId/members', inTeam(async (c, { client, workspaceId }) => {
    const { rows } = await client.query(
      `SELECT m.user_id AS "userId",u.email FROM teamspace_members m JOIN users u ON u.id=m.user_id
       WHERE m.workspace_id=$1 AND m.teamspace_id=$2 ORDER BY u.email`, [workspaceId, c.req.param('teamspaceId')],
    );
    return c.json({ members: rows });
  }));

  router.post('/:teamspaceId/members', inTeam(async (c, { client, workspaceId, input }) => {
    const userId = shellMemberId((input as { userId?: unknown } | null)?.userId);
    if (!userId) return c.json({ error: 'invalid_request' }, 400);
    const { rows: [member] } = await client.query(
      `SELECT m.user_id AS "userId",u.email FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.workspace_id=$1 AND m.user_id=$2 FOR KEY SHARE OF m`, [workspaceId, userId],
    );
    if (!member) return c.json({ error: 'not_workspace_member' }, 400);
    const inserted = await client.query(
      'INSERT INTO teamspace_members(workspace_id,teamspace_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [workspaceId, c.req.param('teamspaceId'), userId],
    );
    if (!inserted.rowCount) return c.json({ error: 'already_member' }, 409);
    return c.json({ member }, 201);
  }));

  router.delete('/:teamspaceId/members/:userId', inTeam(async (c, { client, workspaceId }) => {
    const userId = shellMemberId(c.req.param('userId'));
    if (!userId) return c.json({ error: 'invalid_request' }, 400);
    const removed = await client.query(
      'DELETE FROM teamspace_members WHERE workspace_id=$1 AND teamspace_id=$2 AND user_id=$3',
      [workspaceId, c.req.param('teamspaceId'), userId],
    );
    if (!removed.rowCount) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  }));

  return router;
}
