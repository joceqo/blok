import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PgPool } from '../db/pool.ts';
import { sessionDigest } from './session.ts';
import type { InviteMail } from './invite-mail.ts';
import { readWorkspaceScope, WorkspaceError } from './workspace-scope.ts';

export function parseInvite(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceError(400, 'Invalid JSON');
  const body = value as Record<string, unknown>;
  const email = body.email;
  const message = body.message ?? '';
  const role = body.role === '' ? 'member' : body.role ?? 'member';
  if (typeof email !== 'string') throw new WorkspaceError(400, 'Invalid email');
  if (typeof message !== 'string') throw new WorkspaceError(400, 'Invalid JSON');
  if ([...message].length > 2000) throw new WorkspaceError(400, 'Invitation message must be at most 2000 characters');
  if (role !== 'member' && role !== 'viewer') throw new WorkspaceError(400, 'Invalid role');
  return { email, message, role };
}

export function createWorkspaceInvites(pool: PgPool, mail: InviteMail) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof WorkspaceError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  app.use('*', bodyLimit({ maxSize: 8 << 20, onError: c => c.json({error:'Invalid JSON'}, 400) }));
  app.all('/:inviteId?', async c => {
    const key = sessionDigest(c);
    if (!key) throw new WorkspaceError(401, 'Sign in required');
    const method = c.req.method;
    const id = c.req.param('inviteId');
    const write = method !== 'GET' && method !== 'HEAD';
    const body = method === 'POST' && !id ? await c.req.json().catch(() => null) : null;
    const client = await pool.connect();
    let delivery: { id: string; message: string } | undefined;
    try {
      await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scope = await readWorkspaceScope(client, key, c.req.param('slug')!, write);
      if (scope.role !== 'admin') throw new WorkspaceError(403, 'Administrator required');
      if (!write && !id) {
        const { rows } = await client.query(`SELECT id,email,role,status,expires_at AS "expiresAt" FROM invites
          WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC`, [scope.workspace_id]);
        await client.query('COMMIT');
        return c.json({ invites: rows });
      }
      if (method === 'DELETE' && id) {
        const change = await client.query(`UPDATE invites SET status='revoked' WHERE id=$1 AND workspace_id=$2
          AND status IN ('pending','delivering')`, [id,scope.workspace_id]);
        if (!change.rowCount) throw new WorkspaceError(404, 'Pending invitation not found');
        await client.query('COMMIT');
        return c.json({ok:true});
      }
      if (method !== 'POST' || id) {
        await client.query('ROLLBACK');
        return c.json({error:'Method not allowed'}, 405);
      }
      const invite = parseInvite(body);
      const email = await mail.normalize(invite.email);
      const { rows: [quota] } = await client.query<{ count: number }>(`INSERT INTO email_rate_limits(key,count) VALUES($1,1)
        ON CONFLICT(key) DO UPDATE SET count=CASE WHEN email_rate_limits.window_start<now()-interval '1 hour' THEN 1 ELSE email_rate_limits.count+1 END,
        window_start=CASE WHEN email_rate_limits.window_start<now()-interval '1 hour' THEN now() ELSE email_rate_limits.window_start END RETURNING count`,
      ['invite:' + scope.user_id]);
      if (quota!.count > 30) {
        await client.query('COMMIT');
        return c.json({error:'Too many invitations'}, 429);
      }
      delivery = { id: randomBytes(32).toString('base64url'), message: invite.message };
      await client.query(`INSERT INTO invites(id,workspace_id,email,role,status,expires_at)
        VALUES($1,$2,$3,$4,'delivering',now()+interval '7 days')`, [delivery.id,scope.workspace_id,email,invite.role]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    try {
      await mail.deliver(delivery.id, delivery.message);
    } catch {
      await pool.query("UPDATE invites SET status='delivery-failed' WHERE id=$1 AND status='delivering'", [delivery.id]);
      return c.json({error:'Invitation email delivery failed'}, 503);
    }
    // A concurrent revocation takes precedence, even after email delivery.
    const result = await pool.query("UPDATE invites SET status='pending' WHERE id=$1 AND status='delivering'", [delivery.id]);
    if (!result.rowCount) return c.json({error:'Invitation revoked during delivery'}, 409);
    return c.json({ok:true}, 201);
  });
  return app;
}
