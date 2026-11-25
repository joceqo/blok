import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashSecret } from '../auth/codes.ts';
import type { PgPool } from '../db/pool.ts';
import { issueSession } from './auth.ts';
import { inTransaction } from './bootstrap.ts';
import { loadSession } from './session.ts';

export function deviceCredential(value: string | undefined) {
  if (value === undefined) return;
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid embedded device credential');
  return value;
}

// Called before the embedded HTTP listener opens, and inside a transaction when
// the native process needs a session. Never acquire ownership of an existing user.
export async function ensureDeviceAccount(db: PoolClient) {
  await db.query('SELECT pg_advisory_xact_lock(774839103)');
  const { rows: [device] } = await db.query<{user_id: string; workspace_id: string | null}>(
    'SELECT user_id,workspace_id FROM desktop_device_account WHERE singleton');
  if (device?.workspace_id) {
    const membership = await db.query('SELECT FROM memberships WHERE user_id=$1 AND workspace_id=$2', [device.user_id, device.workspace_id]);
    if (membership.rowCount) return device.user_id;
  }
  const user = device?.user_id ?? randomUUID();
  const id = randomUUID();
  const {rows:[settings]} = await db.query<{fresh:boolean}>(`SELECT setup_completed_at IS NULL
    AND NOT EXISTS(SELECT FROM users) AND NOT EXISTS(SELECT FROM workspaces) AS fresh
    FROM instance_settings WHERE id FOR UPDATE`);
  // The empty address is rejected by all email authentication paths.
  if (!device) await db.query("INSERT INTO users(id,email,name) VALUES($1,'','Profil local')", [user]);
  const local = await db.query("INSERT INTO workspaces(id,slug,name) VALUES($1,'local','Mon espace') ON CONFLICT(slug) DO NOTHING", [id]);
  if (!local.rowCount) await db.query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Mon espace')", [id,'local-' + id]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [id,user]);
  await db.query(`INSERT INTO desktop_device_account(user_id,workspace_id) VALUES($1,$2)
    ON CONFLICT(singleton) DO UPDATE SET workspace_id=excluded.workspace_id`, [user,id]);
  if (settings?.fresh) {
    await db.query('INSERT INTO instance_admins(user_id) VALUES($1)', [user]);
    await db.query('UPDATE instance_settings SET default_workspace_id=$1,setup_completed_at=now(),updated_by=$2 WHERE id', [id,user]);
  }
  return user;
}

// Share a session across windows using this native supervisor. If a logout or an
// expiry invalidates the bearer, a new issuance must not resurrect the old token.
export function createDeviceSessions(pool: PgPool) {
  let token: string | undefined;
  let pending: Promise<Awaited<ReturnType<typeof issueSession>>> | undefined;
  return () => {
    pending ??= inTransaction(pool, async db => {
      const user = await ensureDeviceAccount(db);
      if (token) {
        const session = await loadSession(db, hashSecret(token));
        if (session?.user.id === user) return {...session, token};
      }
      await db.query('DELETE FROM sessions WHERE user_id=$1 AND expires_at<=now()', [user]);
      return issueSession(db, user, []);
    }).then(session => { token = session.token; return session; }).finally(() => { pending = undefined; });
    return pending;
  };
}
