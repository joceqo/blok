import { timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import type { PoolClient } from 'pg';
import { bodyLimit } from 'hono/body-limit';
import { setCookie } from 'hono/cookie';
import { generateSessionToken, hashSecret, normalizeEmail, SESSION_COOKIE } from '../auth/codes.ts';
import type { PgPool } from '../db/pool.ts';
import { loadSession, sessionDigest } from './session.ts';

import { inTransaction } from './bootstrap.ts';
import { passwordAuthAvailable, validateAddress } from './mail.ts';
import { verifyPassword, validPassword } from './password.ts';
import { consumeRate, trustedClientIP } from './request-code.ts';

async function pendingInvitations(db: PoolClient, email: string) {
  const {rows} = await db.query<{ id: string }>(
    "SELECT id FROM invites WHERE email=$1 AND status='pending' AND expires_at>now() ORDER BY id FOR UPDATE", [email]);
  return rows.map(row => row.id);
}

async function issueSession(db: PoolClient, userId: string, invites: string[]) {
  if (invites.length) {
    await db.query(`INSERT INTO memberships(workspace_id,user_id,role)
      SELECT DISTINCT ON (workspace_id) workspace_id,$1,role FROM invites WHERE id=ANY($2::text[])
      ORDER BY workspace_id,created_at DESC,id DESC ON CONFLICT(workspace_id,user_id) DO NOTHING`, [userId, invites]);
    await db.query("UPDATE invites SET status='accepted' WHERE id=ANY($1::text[])", [invites]);
  }
  const token = generateSessionToken();
  const key = hashSecret(token);
  await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [key, userId]);
  const session = await loadSession(db, key);
  if (!session) throw new Error('Session missing after creation');
  return { token, user: session.user, workspaces: session.workspaces };
}

export function createShellAuth(pool: PgPool, secret: string, recheckSessions: () => Promise<void>) {
  const routes = new Hono();
  const cookie = { path: '/', sameSite: 'Lax', httpOnly: true, secure: process.env.BLOK_DEVELOPMENT !== '1' } as const;
  function respondSession(c: Context, {token, ...session}: Awaited<ReturnType<typeof issueSession>>, native: boolean) {
    if (native) return c.json({...session, token});
    setCookie(c, SESSION_COOKIE, token, {...cookie, maxAge: 30 * 86400});
    return c.json(session);
  }

  const clientIP = trustedClientIP(process.env.TRUSTED_PROXY_CIDRS ?? '');
  routes.post('/password', bodyLimit({ maxSize: 8192 }), async c => {
    if (!passwordAuthAvailable()) return c.json({error:'Password sign-in is disabled'}, 403);
    const input = await c.req.json().catch(() => null);
    const email = typeof input?.email === 'string' && validateAddress(input.email);
    const invalid = () => c.json({error:'Adresse e-mail ou mot de passe incorrect.'}, 401);
    if (!email || !validPassword(input?.password)) return invalid();
    const ip = clientIP(getConnInfo(c).remote.address ?? 'unknown', c.req.header('X-Forwarded-For') ?? '');
    if (!await consumeRate(pool,'password-ip:'+ip,30) || !await consumeRate(pool,'password-email:'+email,8))
      return c.json({error:'Trop de tentatives. Réessayez plus tard.'}, 429);

    const {rows:[user]} = await pool.query<{id:string; password_hash:string | null}>(
      'SELECT id,password_hash FROM users WHERE email=$1', [email]);
    if (!await verifyPassword(input.password, user?.password_hash) || !user) return invalid();
    const session = await inTransaction(pool, async db => {
      const invites = await pendingInvitations(db, email);
      // A concurrent password change or account removal invalidates this verification.
      const current = await db.query('SELECT id FROM users WHERE id=$1 AND password_hash=$2 FOR SHARE', [user.id, user.password_hash]);
      if (!current.rowCount) return;
      return issueSession(db, user.id, invites);
    });
    return session ? respondSession(c, session, input.client === 'desktop') : invalid();
  });

  routes.post('/verify-code', bodyLimit({ maxSize: 8192 }), async c => {
    const input = await c.req.json().catch(() => null);
    const email = typeof input?.email === 'string' ? normalizeEmail(input.email) : '';
    if (!/^[^\s@<>]+@[^\s@<>]+$/u.test(email) || Buffer.byteLength(email) > 254 ||
        typeof input?.code !== 'string' || Buffer.byteLength(input.code) !== 6) {
      return c.json({ error: 'Invalid code' }, 400);
    }
    const client = await pool.connect();
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
      const invites = await pendingInvitations(client, email);
      const existing = await client.query('SELECT id FROM users WHERE email=$1', [email]);
      const domain = email.slice(email.lastIndexOf('@') + 1);
      const allowed = settings?.signup_policy === 'open' || (settings?.signup_policy === 'domain' &&
        settings.signup_domains.some(value => value.trim().toLowerCase() === domain));
      if (!existing.rowCount && !invites.length && !allowed) {
        await client.query('ROLLBACK');
        return c.json({ error: 'Invalid or expired code' }, 401);
      }
      const { rows: [user] } = await client.query<{ id: string }>(
        'INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=excluded.email RETURNING id',
        [generateSessionToken(), email]);
      await client.query('DELETE FROM login_codes WHERE email=$1', [email]);
      const session = await issueSession(client, user!.id, invites);
      await client.query('COMMIT');
      return respondSession(c, session, input.client === 'desktop');
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
