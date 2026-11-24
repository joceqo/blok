import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setCookie } from 'hono/cookie';
import { generateSessionToken, hashSecret, normalizeEmail, SESSION_COOKIE } from '../auth/codes.js';
import type { PgPool } from '../db/pool.js';
import { loadSession, sessionDigest } from './session.js';

export function createShellAuth(pool: PgPool, secret: string, recheckSessions: () => Promise<void>) {
  const routes = new Hono();
  const cookie = { path: '/', sameSite: 'Lax', httpOnly: true, secure: process.env.BLOK_DEVELOPMENT !== '1' } as const;
  routes.post('/verify-code', bodyLimit({ maxSize: 8192 }), async c => {
    const input = await c.req.json().catch(() => null);
    const email = typeof input?.email === 'string' ? normalizeEmail(input.email) : '';
    if (!/^[^\s@<>]+@[^\s@<>]+$/u.test(email) || Buffer.byteLength(email) > 254 ||
        typeof input?.code !== 'string' || Buffer.byteLength(input.code) !== 6) {
      return c.json({ error: 'Invalid code' }, 400);
    }
    const client = await pool.connect();
    const token = generateSessionToken();
    const key = hashSecret(token);
    try {
      await client.query('BEGIN');
      const { rows: [challenge] } = await client.query<{ digest: string }>(
        'SELECT digest FROM login_codes WHERE email=$1 AND attempts<5 AND expires_at>now() FOR UPDATE', [email]);
      if (!challenge) {
        await client.query('ROLLBACK');
        return c.json({ error: 'Invalid or expired code' }, 401);
      }
      const stored = Buffer.from(challenge.digest, 'hex');
      const supplied = Buffer.from(hashSecret(email + ':' + input.code + ':' + secret), 'hex');
      if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) {
        await client.query('UPDATE login_codes SET attempts=attempts+1 WHERE email=$1', [email]);
        await client.query('COMMIT');
        return c.json({ error: 'Invalid or expired code' }, 401);
      }
      // Lock the settings and invitations before checking admission. A concurrent
      // revocation or policy change takes effect in a single serial order with login.
      const { rows: [settings] } = await client.query<{ signup_policy: string; signup_domains: string[] }>(
        'SELECT signup_policy, signup_domains FROM instance_settings WHERE id FOR SHARE');
      const pending = await client.query<{ id: string }>(
        "SELECT id FROM invites WHERE email=$1 AND status='pending' AND expires_at>now() ORDER BY id FOR UPDATE", [email]);
      const existing = await client.query('SELECT id FROM users WHERE email=$1', [email]);
      const domain = email.slice(email.lastIndexOf('@') + 1);
      const allowed = settings?.signup_policy === 'open' || (settings?.signup_policy === 'domain' &&
        settings.signup_domains.some(value => value.trim().toLowerCase() === domain));
      if (!existing.rowCount && !pending.rowCount && !allowed) {
        await client.query('ROLLBACK');
        return c.json({ error: 'Invalid or expired code' }, 401);
      }
      const { rows: [user] } = await client.query<{ id: string }>(
        'INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=excluded.email RETURNING id',
        [generateSessionToken(), email]);
      const invites = pending.rows.map(row => row.id);
      if (invites.length) {
        await client.query(`INSERT INTO memberships(workspace_id,user_id,role)
          SELECT DISTINCT ON (workspace_id) workspace_id,$1,role FROM invites WHERE id=ANY($2::text[])
          ORDER BY workspace_id,created_at DESC,id DESC ON CONFLICT(workspace_id,user_id) DO NOTHING`, [user!.id, invites]);
        await client.query("UPDATE invites SET status='accepted' WHERE id=ANY($1::text[])", [invites]);
      }
      await client.query('DELETE FROM login_codes WHERE email=$1', [email]);
      await client.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [key, user!.id]);
      const session = await loadSession(client, key);
      if (!session) throw new Error('Session missing after creation');
      await client.query('COMMIT');
      const result = { user: session.user, workspaces: session.workspaces };
      if (input.client === 'desktop') return c.json({ ...result, token });
      setCookie(c, SESSION_COOKIE, token, { ...cookie, maxAge: 30 * 86400 });
      return c.json(result);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
  routes.post('/logout', async c => {
    const digest = sessionDigest(c);
    if (digest) {
      await pool.query('DELETE FROM sessions WHERE id=$1', [digest]);
      await recheckSessions();
    }
    setCookie(c, SESSION_COOKIE, '', { ...cookie, maxAge: 0 });
    return c.json({ ok: true });
  });
  return routes;
}
