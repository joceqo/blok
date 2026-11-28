import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../auth/codes.ts';
import { blokTicket } from '../tickets/hmac.ts';
import { createShellAssets } from './assets.ts';

const database = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!database || !process.env.SHELL_MEDIA_TEST)(
  'private assets with the real Node media process',
  () => {
    const schema = 'media_' + randomUUID().replaceAll('-', '');
    const db = new pg.Pool({ connectionString: database, options: '-csearch_path=' + schema });
    const admin = new pg.Pool({ connectionString: database });
    const secret = 'media'.repeat(10);
    const origin = 'http://localhost:8080';
    let dir: string, child: ChildProcess, app: ReturnType<typeof createShellAssets>;
    function call(url: string, user = 'member', init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (user) headers.set('Authorization', 'Bearer ' + user);
      return app.request(url, { ...init, headers });
    }
    beforeAll(async () => {
      await admin.query('CREATE SCHEMA ' + schema);
      await db.query(await readFile(new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
      await db.query(`INSERT INTO users(id,email) VALUES ('member','member@test'),('viewer','viewer@test');
      INSERT INTO workspaces(id,slug,name) VALUES ('ws','demo','Demo');
      INSERT INTO memberships VALUES ('ws','member','member'),('ws','viewer','viewer');
      INSERT INTO pages(id,workspace_id,metadata,visibility) VALUES ('page','ws','{}','private');
      INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES ('page','member','edit','member')`);
      for (const user of ['viewer', 'member'])
        await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [
          hashSecret(user),
          user,
        ]);
      dir = await mkdtemp(join(tmpdir(), 'blok-private-media-'));
      vi.stubEnv('DATA_DIRECTORY', dir);
      vi.stubEnv('TICKET_SECRET', secret);
      vi.stubEnv('PUBLIC_URL', origin);
      const reserved = createServer();
      reserved.listen(0, '127.0.0.1');
      await once(reserved, 'listening');
      const addr = reserved.address();
      if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
      await new Promise<void>((done) => reserved.close(() => done()));
      const listen = '127.0.0.1:' + addr.port;
      const binary = fileURLToPath(
        new URL('../../../../packages/server/node/dist/blok-server.mjs', import.meta.url),
      );
      child = spawn(
        process.execPath,
        [
          binary,
          '--listen',
          listen,
          '--auth',
          'ticket',
          '--storage-dir',
          join(dir, 'uploads'),
          '--public-url',
          origin + '/files',
          '--allow-origin',
          origin,
        ],
        {
          env: { ...process.env, BLOK_SECRET: secret },
          stdio: 'ignore',
        },
      );
      await vi.waitFor(async () => expect((await fetch('http://' + listen + '/health')).ok).toBe(true), {
        timeout: 5000,
      });
      app = createShellAssets(db, secret, 'http://' + listen);
    });
    afterAll(async () => {
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      vi.unstubAllEnvs();
      if (dir) await rm(dir, { recursive: true, force: true });
      await db.end();
      try {
        await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      } finally {
        await admin.end();
      }
    });
    it('persists an uploaded document asset, supports partial reads and revokes an already-issued grant', async () => {
      const ticket = blokTicket(secret, {
        user: hashSecret('member'),
        doc: 'page',
        write: true,
        ttlSeconds: 60,
      });
      const form = new FormData();
      form.set('file', new Blob(['private content bytes'], { type: 'text/plain' }), 'name.txt');
      const uploaded = await call('/api/blok/upload', ticket, { method: 'POST', body: form });
      expect(uploaded.status, await uploaded.clone().text()).toBe(200);
      const { url } = await uploaded.json();
      const signing = '/api/assets/url?url=' + encodeURIComponent(url);
      expect((await call(signing, 'viewer')).status).toBe(403);
      const signed = await (await call(signing)).json();
      const resource = new URL(signed.url);
      const partial = await call(resource.pathname + resource.search, '', {
        headers: { Range: 'bytes=0-6' },
      });
      expect(partial.status).toBe(206);
      expect(await partial.text()).toBe('private');
      expect(partial.headers.get('Referrer-Policy')).toBe('no-referrer');
      await db.query("DELETE FROM page_shares WHERE page_id='page' AND user_id='member'");
      expect((await call(resource.pathname + resource.search, '')).status).toBe(403);
      expect((await call('/api/blok/upload', ticket, { method: 'POST', body: form })).status).toBe(403);
    });
    it('stores workspace images and scopes emoji creation and deletion to current permissions', async () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
      const post = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      };
      expect((await call('/api/workspaces/demo/images', 'viewer', post)).status).toBe(403);
      const image = await call('/api/workspaces/demo/images', 'member', post);
      expect(image.status, await image.clone().text()).toBe(201);
      const { url } = await image.json();
      expect((await call(url, 'viewer')).status).toBe(200);
      const emoji = '/api/workspaces/demo/emojis';
      const created = await call(emoji, 'member', {
        ...post,
        body: JSON.stringify({ dataUrl, name: 'wave' }),
      });
      expect(created.status).toBe(201);
      const { id } = await created.json();
      expect((await (await call(emoji, 'viewer')).json()).emojis).toHaveLength(1);
      expect((await call(emoji + '/' + id, 'viewer', { method: 'DELETE' })).status).toBe(403);
      expect((await call(emoji + '/' + id, 'member', { method: 'DELETE' })).status).toBe(200);
    });
  },
);
