import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { passwordAuthAvailable, validateAddress } from './mail.ts';
import { hashPassword, validPassword } from './password.ts';

export async function seedDemo(pool: PgPool) {
  if (process.env.APP_ENV !== 'development' || !passwordAuthAvailable())
    throw new Error('The demo seed requires a local development instance without outgoing mail');
  const accounts = [
    { email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.test', key: 'DEMO_ADMIN_PASSWORD' },
    { email: process.env.DEMO_MEMBER_EMAIL ?? 'membre@example.test', key: 'DEMO_MEMBER_PASSWORD' },
    { email: process.env.DEMO_REQUESTER_EMAIL ?? 'demandeur@example.test', key: 'DEMO_REQUESTER_PASSWORD' },
  ].map(({ email, key }) => {
    const address = validateAddress(email);
    if (!address?.endsWith('@example.test')) throw new Error('Demo addresses must use @example.test');
    const password = process.env[key];
    if (!validPassword(password)) throw new Error('Set a valid ' + key + ' in the demo environment file');
    return { email: address, password };
  });
  if (new Set(accounts.map(({ email }) => email)).size !== accounts.length)
    throw new Error('The demo accounts must use distinct addresses');

  const slug = process.env.BOOTSTRAP_WORKSPACE_SLUG ?? 'equipe';
  return inTransaction(pool, async (db) => {
    const marker = await db.query(
      'INSERT INTO bootstrap_markers(name) VALUES($1) ON CONFLICT DO NOTHING',
      ['local-demo-passwords:' + slug],
    );
    if (!marker.rowCount) return 'Demo accounts already provisioned';
    const workspace = await db.query(
      `SELECT w.id FROM workspaces w
       JOIN memberships m ON m.workspace_id=w.id AND m.role='admin'
       JOIN instance_admins a ON a.user_id=m.user_id
       JOIN users u ON u.id=m.user_id WHERE w.slug=$1 AND u.email=$2`,
      [slug, accounts[0]!.email],
    );
    if (!workspace.rowCount) throw new Error('The bootstrap account must administer the demo instance and workspace');
    // Older demos used a volume marker. Only backfill credentials there so a
    // regular restart preserves membership, signup policy and deleted accounts.
    const legacy = existsSync('/data/.demo-seeded');
    for (const { email, password } of accounts) {
      const hash = await hashPassword(password);
      if (legacy) {
        await db.query('UPDATE users SET password_hash=$2 WHERE email=$1 AND password_hash IS NULL', [email, hash]);
      } else {
        await db.query(
          `INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)
           ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash WHERE users.password_hash IS NULL`,
          [randomUUID(), email, hash],
        );
      }
    }
    if (!legacy) {
      await db.query(
        `INSERT INTO memberships(workspace_id,user_id,role) SELECT $1,id,'member' FROM users WHERE email=$2
         ON CONFLICT DO NOTHING`,
        [workspace.rows[0].id, accounts[1]!.email],
      );
    }
    return 'Local demo accounts provisioned';
  });
}
