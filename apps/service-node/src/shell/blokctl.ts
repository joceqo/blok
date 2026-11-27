#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool, type PgPool } from '../db/pool.ts';
import { inTransaction } from './bootstrap.ts';
import { seedDemo } from './demo-seed.ts';
import { hashPassword, validPassword } from './password.ts';
import { mailTemplate } from './mail-template.ts';
import { readInstanceSettings, updateInstanceSettings } from './instance-settings.ts';
import { mailBackend, passwordAuthAvailable, sendMail, validateAddress } from './mail.ts';

const usage = `usage: blokctl <command>

  blokctl admin grant <email>
  blokctl admin list
  blokctl admin revoke <email>
  blokctl user set-password <email>  (read the password from stdin)
  blokctl demo seed
  blokctl settings show
  blokctl settings set key=value...
  blokctl email test <address>`;

const keys = new Map([
  ['name', 'name'],
  ['signup-policy', 'signupPolicy'],
  ['signup-domains', 'signupDomains'],
  ['workspace-creation', 'workspaceCreation'],
  ['default-workspace-id', 'defaultWorkspaceId'],
]);

export async function runBlokctl(pool: PgPool, args: string[], input = process.stdin) {
  const [group, action, ...rest] = args;
  const schema = await pool.query('SELECT max(version) AS version FROM schema_migrations');
  if (!(schema.rows[0]?.version >= 7))
    throw new Error('Database schema is behind this blokctl. Start the server to migrate first');
  if (group === 'demo' && action === 'seed' && !rest.length) return seedDemo(pool);
  if (group === 'user' && action === 'set-password' && rest.length === 1) {
    if (!passwordAuthAvailable()) throw new Error('Password login is disabled with outgoing mail configured');
    const email = validateAddress(rest[0]!);
    if (!email) throw new Error('Invalid email');
    if (input.isTTY) throw new Error('Pipe the password on stdin');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of input) {
      const data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > 1026) throw new Error('Password exceeds the size limit');
      chunks.push(data);
    }
    const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (!validPassword(password)) throw new Error('Invalid password length');
    const hash = await hashPassword(password);
    return inTransaction(pool, async (db) => {
      const account = await db.query('UPDATE users SET password_hash=$2 WHERE email=$1 RETURNING id', [email, hash]);
      if (!account.rowCount) throw new Error('Unknown user');
      await db.query('DELETE FROM sessions WHERE user_id=$1', [account.rows[0].id]);
      return 'Password set for ' + email;
    });
  }
  if (group === 'settings' && action === 'show' && !rest.length)
    return JSON.stringify(await readInstanceSettings(pool), null, 2);
  if (group === 'settings' && action === 'set' && rest.length) {
    const patch: Record<string, unknown> = {};
    for (const pair of rest) {
      const i = pair.indexOf('=');
      const key = i > 0 && keys.get(pair.slice(0, i));
      if (!key) throw new Error('Unknown or malformed setting');
      const value = pair.slice(i + 1);
      patch[key] =
        key === 'signupDomains'
          ? value
              .split(',')
              .map((v) => v.trim().toLowerCase())
              .filter(Boolean)
          : value;
    }
    return JSON.stringify(
      await inTransaction(pool, (db) => updateInstanceSettings(db, patch, null)),
      null,
      2,
    );
  }
  if (group === 'admin' && action === 'list' && !rest.length) {
    const { rows } = await pool.query(
      'SELECT u.email FROM instance_admins a JOIN users u ON u.id=a.user_id ORDER BY u.email',
    );
    return rows.map((r) => r.email).join('\n');
  }
  if (
    rest.length !== 1 ||
    !(
      (group === 'admin' && ['grant', 'revoke'].includes(action!)) ||
      (group === 'email' && action === 'test')
    )
  )
    throw new Error(usage);
  const email = validateAddress(rest[0]!);
  if (!email) throw new Error('Invalid email');
  if (group === 'email') {
    const { text, html } = await mailTemplate('delivery-test', {
      publicURL: process.env.PUBLIC_URL ?? '',
    });
    await sendMail(email, 'Test de livraison Blok', text, html);
    return 'ok backend=' + mailBackend();
  }
  return inTransaction(pool, async (db) => {
    await db.query('SELECT id FROM instance_settings WHERE id FOR UPDATE');
    if (action === 'grant') {
      const inserted = await db.query(
        'INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(email) DO NOTHING',
        [randomUUID(), email],
      );
      await db.query(
        'INSERT INTO instance_admins(user_id) SELECT id FROM users WHERE email=$1 ON CONFLICT DO NOTHING',
        [email],
      );
      return (inserted.rowCount ? 'created and granted' : 'granted') + ' instance admin: ' + email;
    }
    const {
      rows: [user],
    } = await db.query(
      'SELECT user_id FROM instance_admins a JOIN users u ON a.user_id=u.id WHERE u.email=$1',
      [email],
    );
    if (user) {
      const total = await db.query('SELECT count(*)::int AS count FROM instance_admins');
      if (total.rows[0].count <= 1) throw new Error('Cannot remove the last instance administrator');
      await db.query('DELETE FROM instance_admins WHERE user_id=$1', [user.user_id]);
    }
    return 'revoked instance admin: ' + email;
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (['help', '-h', '--help'].includes(args[0] ?? '')) {
    console.log(usage);
    return;
  }
  if (!args.length) throw new Error(usage);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const output = await runBlokctl(pool, args);
    if (output) console.log(output);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
