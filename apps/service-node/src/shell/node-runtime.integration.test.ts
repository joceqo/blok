import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapShell } from './bootstrap.ts';
import { createShellApp } from './app.ts';
import { hashSecret } from '../auth/codes.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('Standalone shell bootstrap and administration', () => {
  const schema = 'runtime_' + randomUUID().replaceAll('-', '');
  const system = new pg.Pool({ connectionString: url });
  const db = new pg.Pool({ connectionString: url, options: '-csearch_path=' + schema });
  const email = 'owner@example.test',
    secret = 's'.repeat(32);
  const env = { BOOTSTRAP_ADMIN_EMAIL: '', BLOK_SCHEMA_PATH: process.env.SHELL_TEST_SCHEMA_PATH };
  let directory: string, origin: string, server: ServerType, adminToken: string, secondToken: string;
  const call = async (method: string, path: string, data?: unknown, token?: string) =>
    fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: data ? JSON.stringify(data) : undefined,
    });
  beforeAll(async () => {
    await system.query('CREATE SCHEMA ' + schema);
    await bootstrapShell(db, env);
    directory = await mkdtemp(join(tmpdir(), 'blok-runtime-mail-'));
    vi.stubEnv('APP_ENV', 'development');
    vi.stubEnv('DEV_MAIL_DIRECTORY', directory);
    const app = createShellApp(db, secret, new Set());
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP listener');
    origin = 'http://127.0.0.1:' + addr.port;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.end();
    await system.query('DROP SCHEMA ' + schema + ' CASCADE');
    await system.end();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('claims the instance once, verifies the mailbox and applies current admin policies', async () => {
    expect((await (await call('GET', '/api/instance')).json()).setupRequired).toBe(true);
    const claim = { email, name: 'Owner', workspace: { name: 'Test', slug: 'test' } };
    const attempts = await Promise.all([
      call('POST', '/api/setup/claim', claim),
      call('POST', '/api/setup/claim', claim),
    ]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    const [letter] = await readdir(directory);
    const message = await readFile(join(directory, letter!), 'utf8');
    const code = /\b\d{6}\b/.exec(JSON.parse(message).text)?.[0];
    const login = await call('POST', '/api/auth/verify-code', { email, code, client: 'desktop' });
    expect(login.status).toBe(200);
    adminToken = (await login.json()).token;
    const user = await call('POST', '/api/admin/users', { email: 'other@example.test' }, adminToken);
    expect(user.status).toBe(201);
    const { id } = await user.json();
    secondToken = randomUUID();
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [
      hashSecret(secondToken),
      id,
    ]);
    expect((await call('GET', '/api/admin/settings', undefined, secondToken)).status).toBe(403);
    expect(
      (await call('POST', '/api/workspaces', { name: 'Forbidden', slug: 'new-space' }, secondToken)).status,
    ).toBe(403);
    expect(
      (await call('POST', '/api/workspaces/test/join-requests', { message: 'Bonjour' }, secondToken)).status,
    ).toBe(200);
    const { requests } = await (
      await call('GET', '/api/workspaces/test/join-requests', undefined, adminToken)
    ).json();
    expect(
      (
        await call(
          'POST',
          '/api/workspaces/test/join-requests/' + requests[0].id + '/approve',
          { role: 'viewer' },
          adminToken,
        )
      ).status,
    ).toBe(200);
    expect((await (await call('GET', '/api/workspaces/test', undefined, secondToken)).json()).role).toBe(
      'viewer',
    );
    const owner = (await (await call('GET', '/api/session', undefined, adminToken)).json()).user.id;
    expect(
      (await call('PATCH', '/api/admin/users/' + owner, { instanceAdmin: false }, adminToken)).status,
    ).toBe(409);
    expect((await call('PATCH', '/api/admin/users/' + id, { instanceAdmin: true }, adminToken)).status).toBe(
      200,
    );
    expect(
      (await call('PATCH', '/api/admin/users/' + owner, { instanceAdmin: false }, secondToken)).status,
    ).toBe(200);
    await bootstrapShell(db, {
      ...env,
      BOOTSTRAP_ADMIN_EMAIL: email,
      BOOTSTRAP_WORKSPACE_NAME: 'Test',
      BOOTSTRAP_WORKSPACE_SLUG: 'test',
    });
    expect((await call('GET', '/api/admin/settings', undefined, adminToken)).status).toBe(403);
    expect((await call('GET', '/api/admin/settings', undefined, secondToken)).status).toBe(200);
  });
});
