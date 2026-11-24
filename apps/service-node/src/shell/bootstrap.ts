import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import type { PgPool } from '../db/pool.ts';

export async function inTransaction<T>(pool: PgPool, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function bootstrapShell(pool: PgPool, env = process.env) {
  const schema = await readFile(
    env.BLOK_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url),
    'utf8',
  );
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const slug = env.BOOTSTRAP_WORKSPACE_SLUG?.trim().toLowerCase();
  const name = env.BOOTSTRAP_WORKSPACE_NAME?.trim();
  if (email && !/^[^\s@<>]+@[^\s@<>]+$/.test(email)) throw new Error('Invalid bootstrap email');
  if (Boolean(slug) !== Boolean(name) || (slug && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)))
    throw new Error('Invalid bootstrap workspace');
  await inTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(774839102)');
    await db.query(schema);
    if (email && slug && name) {
      await db.query('INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3) ON CONFLICT(slug) DO NOTHING', [
        randomUUID(),
        slug,
        name,
      ]);
    }
    await db.query(
      'UPDATE instance_settings SET default_workspace_id=(SELECT id FROM workspaces) WHERE default_workspace_id IS NULL AND (SELECT count(*) FROM workspaces)=1',
    );
    if (!email) {
      await db.query(`INSERT INTO instance_admins(user_id)
        SELECT m.user_id FROM memberships m JOIN instance_settings s ON s.default_workspace_id=m.workspace_id
        WHERE m.role='admin' AND s.setup_completed_at IS NOT NULL AND NOT EXISTS(SELECT FROM instance_admins)
        ON CONFLICT DO NOTHING`);
      return;
    }
    await db.query('INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(email) DO NOTHING', [
      randomUUID(),
      email,
    ]);
    await db.query(
      `INSERT INTO instance_admins(user_id) SELECT id FROM users WHERE email=$1
      AND NOT EXISTS(SELECT FROM instance_admins) ON CONFLICT DO NOTHING`,
      [email],
    );
    if (slug)
      await db.query(
        `INSERT INTO memberships(workspace_id,user_id,role)
      SELECT w.id,u.id,'admin' FROM workspaces w,users u WHERE w.slug=$1 AND u.email=$2 ON CONFLICT DO NOTHING`,
        [slug, email],
      );
    await db.query(
      'UPDATE instance_settings SET setup_completed_at=coalesce(setup_completed_at,now()) WHERE id',
    );
  });
}
