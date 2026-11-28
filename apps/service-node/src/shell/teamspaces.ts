import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';
import { enrollWorkspaceMembers, manageTeam, teamspaceDirectory, teamspaceMetadata, teamspaceSettings } from './teamspace-directory.ts';
import { parseUserId } from '../models/User.ts';
import { canEditWorkspace, type WorkspaceRole } from '../models/Workspace.ts';
import { canEditPage } from './page-level.ts';
import { loadIndexPages, pageStandings } from './workspace-index.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';
import { sessionDigest } from './session.ts';

interface Scope {
  client: PoolClient;
  workspaceId: string;
  input: unknown;
  userId: string;
  role: WorkspaceRole;
}

type Route = (c: Context, scope: Scope) => Promise<Response>;


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
      const write = method !== 'GET' && method !== 'HEAD';
      await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const actor = await readWorkspaceScope(client, digest, c.req.param('slug')!, write);
      const response = write && !canEditWorkspace(actor.role)
        ? c.json({ error: 'permission_denied', action: 'edit' }, 403)
        : await route(c, { client, workspaceId: actor.workspace_id, userId: actor.user_id, role: actor.role, input });
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof WorkspaceError) {
        if (error.status === 401) return c.json({ error: 'unauthenticated' }, 401);
        return c.json({ error: 'not_found' }, 404);
      }
      throw error;
    } finally {
      client.release();
    }
  };

  const inTeam = (route: Route) => scoped(async (c, scope) => {
    const { rows: [team] } = await scope.client.query(
      `SELECT ${manageTeam} AS manage FROM teamspaces t WHERE t.workspace_id=$1 AND t.id=$4`,
      [scope.workspaceId, scope.userId, scope.role, c.req.param('teamspaceId')],
    );
    if (!team) return c.json({ error: 'not_found' }, 404);
    if (!['GET', 'HEAD'].includes(c.req.method) && !team.manage)
      return c.json({ error: 'permission_denied', action: 'edit' }, 403);
    return route(c, scope);
  });

  async function isRestricted(client: PoolClient, workspaceId: string): Promise<boolean> {
    const { rows: [workspace] } = await client.query('SELECT restrict_teamspace_creation FROM workspaces WHERE id=$1', [workspaceId]);
    return workspace.restrict_teamspace_creation;
  }

  router.get('/', scoped(async (c, { client, workspaceId, userId, role }) => {
    const teams = await teamspaceDirectory(client, workspaceId, userId, role);
    const restrictCreation = await isRestricted(client, workspaceId);
    return c.json({ teamspaces: teams, settings: { restrictCreation }, canCreate: role === 'admin' || (role === 'member' && !restrictCreation) });
  }));

  router.patch('/settings', scoped(async (c, { client, workspaceId, role, input }) => {
    if (role !== 'admin') return c.json({ error: 'permission_denied' }, 403);
    const settings = teamspaceSettings(input);
    if (!settings) return c.json({ error: 'invalid_request' }, 400);
    const ids = settings.defaultTeamspaceIds;
    if (ids) {
      const found = await client.query('SELECT id FROM teamspaces WHERE workspace_id=$1 AND id=ANY($2::text[])', [workspaceId, ids]);
      if (found.rowCount !== ids.length) return c.json({ error: 'not_found' }, 404);
      await client.query(
        `UPDATE teamspaces SET is_default=(id=ANY($2::text[])), updated_at=now()
         WHERE workspace_id=$1 AND is_default IS DISTINCT FROM (id=ANY($2::text[]))`, [workspaceId, ids]);
      await enrollWorkspaceMembers(client, workspaceId, ids);
    }
    if (settings.restrictCreation !== undefined)
      await client.query('UPDATE workspaces SET restrict_teamspace_creation=$2 WHERE id=$1', [workspaceId, settings.restrictCreation]);
    return c.json({ ok: true });
  }));

  router.post('/', scoped(async (c, { client, workspaceId, input, userId, role }) => {
    const meta = teamspaceMetadata(input);
    const makeDefault = (input as {makeDefault?: unknown} | null)?.makeDefault;
    if (!meta?.name || (makeDefault !== undefined && typeof makeDefault !== 'boolean')) return c.json({ error: 'invalid_request' }, 400);
    if (role !== 'admin' && (makeDefault || await isRestricted(client, workspaceId))) return c.json({ error: 'permission_denied' }, 403);
    const id = randomUUID();
    await client.query(
      `INSERT INTO teamspaces(id,workspace_id,name,description,icon,is_default,owner_managed) VALUES($1,$2,$3,$4,$5,$6,true)`,
      [id, workspaceId, meta.name, meta.description ?? '', meta.icon ?? '', makeDefault ?? false]);
    await client.query(`INSERT INTO teamspace_members(workspace_id,teamspace_id,user_id,role) VALUES($1,$2,$3,'owner')`, [workspaceId,id,userId]);
    if (makeDefault) await enrollWorkspaceMembers(client, workspaceId, [id]);
    const [teamspace] = await teamspaceDirectory(client, workspaceId, userId, role, id);
    return c.json({ teamspace }, 201);
  }));

  router.patch('/:teamspaceId', inTeam(async (c, { client, workspaceId, input, userId, role }) => {
    const meta = teamspaceMetadata(input);
    if (!meta) return c.json({ error: 'invalid_request' }, 400);
    const id = c.req.param('teamspaceId')!;
    await client.query(
      `UPDATE teamspaces SET name=coalesce($3,name),description=coalesce($4,description),icon=coalesce($5,icon),updated_at=now()
       WHERE workspace_id=$1 AND id=$2`, [workspaceId, id, meta.name, meta.description, meta.icon]);
    const [teamspace] = await teamspaceDirectory(client, workspaceId, userId, role, id);
    return c.json({ teamspace });
  }));

  router.delete('/:teamspaceId', inTeam(async (c, { client, workspaceId }) => {
    await client.query('DELETE FROM teamspaces WHERE workspace_id=$1 AND id=$2', [workspaceId, c.req.param('teamspaceId')]);
    return c.json({ ok: true });
  }));

  router.get('/:teamspaceId/pages', inTeam(async (c, { client, workspaceId, userId, role }) => {
    const { rows: links } = await client.query<{ page_id: string }>(
      'SELECT page_id FROM teamspace_pages WHERE workspace_id=$1 AND teamspace_id=$2', [workspaceId, c.req.param('teamspaceId')]);
    if (!links.length) return c.json({ pages: [] });
    const linked = new Set(links.map(row => row.page_id));
    const rows = await loadIndexPages(client, workspaceId, userId);
    const access = pageStandings(rows, role);
    const pages = rows.filter(p => linked.has(p.id) && !p.trashed && access[p.id])
      .map(p => ({ id: p.id, title: typeof p.metadata.title === 'string' ? p.metadata.title : '' }));
    return c.json({ pages });
  }));

  router.on(['PUT', 'DELETE'], '/:teamspaceId/pages/:pageId', inTeam(async (c, { client, workspaceId, userId, role }) => {
    const id = c.req.param('pageId')!;
    const rows = await loadIndexPages(client, workspaceId, userId);
    const page = rows.find(p => p.id === id && !p.trashed);
    const level = pageStandings(rows, role)[id]?.level;
    if (!page || !level) return c.json({ error: 'not_found' }, 404);
    if (!canEditPage(level)) return c.json({ error: 'permission_denied', action: 'edit' }, 403);
    const params = [workspaceId, c.req.param('teamspaceId'), id];
    if (c.req.method === 'PUT') {
      await client.query('INSERT INTO teamspace_pages(workspace_id,teamspace_id,page_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', params);
    } else {
      await client.query('DELETE FROM teamspace_pages WHERE workspace_id=$1 AND teamspace_id=$2 AND page_id=$3', params);
    }
    return c.json({ ok: true });
  }));

  router.get('/:teamspaceId/members', inTeam(async (c, { client, workspaceId }) => {
    const { rows } = await client.query(
      `SELECT m.user_id AS "userId",u.name,u.email,m.role,w.role AS "workspaceRole" FROM teamspace_members m
       JOIN memberships w ON w.workspace_id=m.workspace_id AND w.user_id=m.user_id JOIN users u ON u.id=m.user_id
       WHERE m.workspace_id=$1 AND m.teamspace_id=$2 ORDER BY u.email,u.id`, [workspaceId, c.req.param('teamspaceId')],
    );
    return c.json({ members: rows });
  }));

  router.post('/:teamspaceId/members', inTeam(async (c, { client, workspaceId, input }) => {
    const body = input as { userId?: unknown; role?: unknown } | null;
    const userId = parseUserId(body?.userId);
    const role = body?.role === undefined ? 'member' : body.role;
    if (!userId || (role !== 'member' && role !== 'owner')) return c.json({ error: 'invalid_request' }, 400);
    const { rows: [member] } = await client.query(
      `SELECT m.user_id AS "userId",u.name,u.email,m.role AS "workspaceRole" FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.workspace_id=$1 AND m.user_id=$2 FOR KEY SHARE OF m`, [workspaceId, userId]);
    if (!member) return c.json({ error: 'not_workspace_member' }, 400);
    if (role === 'owner' && member.workspaceRole === 'viewer') return c.json({ error: 'viewer_cannot_own' }, 400);
    const inserted = await client.query(
      'INSERT INTO teamspace_members(workspace_id,teamspace_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [workspaceId, c.req.param('teamspaceId'), userId, role]);
    if (!inserted.rowCount) return c.json({ error: 'already_member' }, 409);
    return c.json({ member: { ...member, role } }, 201);
  }));

  router.on(['PATCH','DELETE'], '/:teamspaceId/members/:userId', inTeam(async (c, { client, workspaceId, input }) => {
    const userId = parseUserId(c.req.param('userId'));
    const teamId = c.req.param('teamspaceId');
    const remove = c.req.method === 'DELETE';
    const role = (input as {role?: unknown} | null)?.role;
    if (!userId || (!remove && role !== 'member' && role !== 'owner')) return c.json({ error: 'invalid_request' }, 400);
    const args = [workspaceId, teamId, userId];
    const { rows: [member] } = await client.query(
      `SELECT m.role,w.role AS workspace_role,t.is_default,
       (SELECT count(*)::int FROM teamspace_members o WHERE o.workspace_id=m.workspace_id AND o.teamspace_id=m.teamspace_id AND o.role='owner') AS owners
       FROM teamspace_members m JOIN memberships w ON w.workspace_id=m.workspace_id AND w.user_id=m.user_id
       JOIN teamspaces t ON t.workspace_id=m.workspace_id AND t.id=m.teamspace_id
       WHERE m.workspace_id=$1 AND m.teamspace_id=$2 AND m.user_id=$3`, args);
    if (!member) return c.json({ error: 'not_found' }, 404);
    if (remove && member.is_default) return c.json({ error: 'default_teamspace' }, 409);
    if (member.role === 'owner' && member.owners === 1 && (remove || role === 'member')) return c.json({ error: 'last_owner' }, 409);
    if (!remove && role === 'owner' && member.workspace_role === 'viewer') return c.json({ error: 'viewer_cannot_own' }, 400);
    if (remove)
      await client.query('DELETE FROM teamspace_members WHERE workspace_id=$1 AND teamspace_id=$2 AND user_id=$3', args);
    else
      await client.query('UPDATE teamspace_members SET role=$4 WHERE workspace_id=$1 AND teamspace_id=$2 AND user_id=$3', [...args, role]);
    return c.json({ ok: true });
  }));

  return router;
}
