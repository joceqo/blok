import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShellApp } from './app.js';

// Opt in with a development PostgreSQL URL. Only this suite's schema is used.
const databaseUrl = process.env.SHELL_TEST_DATABASE_URL;
const schemaPath = process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url);
describe.skipIf(!databaseUrl)('shell routes on the deployed PostgreSQL schema', () => {
  const schema = 'test_shell_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const db = new pg.Pool({ connectionString: databaseUrl, options: '-csearch_path=' + schema });
  const secret = 'a'.repeat(32);
  const app = createShellApp(db, secret, new Set());
  const headers = { Authorization: 'Bearer member' };

  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(schemaPath, 'utf8'));
    await db.query(`INSERT INTO users(id,email) VALUES('m','m@example.test');
      INSERT INTO workspaces(id,slug,name) VALUES ('w','demo','Demo');
      INSERT INTO memberships VALUES('w','m','viewer');
      INSERT INTO pages(id,workspace_id,metadata,content,visibility) VALUES
        ('root','w','{}','{"blocks":[]}','private'),
        ('child','w','{"parentId":"root"}','{"blocks":[]}','inherit'),
        ('public','w','{}',null,'workspace'),
        ('hidden','w','{}','{"title":"Secret"}','private')`);
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,'m',now()+interval '1 hour')",
      [createHash('sha256').update('member').digest('hex')]);
  });

  afterAll(async () => {
    await db.end();
    try { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
    finally { await admin.end(); }
  });

  it('matches the session and workspace contracts for cookie and native bearer clients', async () => {
    for (const auth of [headers, { Cookie: 'blok_session=member' }]) {
      const session = await app.request('/api/session', { headers: auth });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ user: { id: 'm', instanceAdmin: false }, workspaces: [{ slug: 'demo', role: 'viewer' }] });
    }
    const ws = await app.request('/api/workspaces', { headers });
    expect(await ws.json()).toEqual({ workspaces: [{ id: 'w', name: 'Demo', role: 'viewer', slug: 'demo' }] });
  });

  it('reads public pages, honors ancestor shares, and hides private pages again on revocation', async () => {
    const read = (id: string) => app.request('/api/workspaces/demo/pages/' + id, { headers });
    expect((await read('public')).status).toBe(200);
    expect((await read('hidden')).status).toBe(404);
    expect((await read('child')).status).toBe(404);
    await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('root','m','view','m')");
    expect((await read('child')).status).toBe(200);
    await db.query("DELETE FROM page_shares WHERE page_id='root' AND user_id='m'");
    expect((await read('child')).status).toBe(404);
    expect((await app.request('/api/workspaces/demo/pages/child', { headers: { Authorization: 'Bearer expired' } })).status).toBe(401);
  });

  it('reads a revision-consistent sidebar index with PostgreSQL ordering and trash', async () => {
    await db.query("UPDATE workspaces SET revision=17 WHERE id='w'");
    await db.query(`INSERT INTO pages(id,workspace_id,metadata,visibility,trashed,deleted) VALUES
      ('idx-a','w','{"id":"idx-a","position":2}','workspace',false,false),
      ('idx-b','w','{"id":"idx-b","position":1}','workspace',false,false),
      ('idx-trash','w','{"id":"idx-trash"}','workspace',true,false),
      ('idx-deleted','w','{"id":"idx-deleted"}','workspace',false,true)`);
    const result = await app.request('/api/workspaces/demo/index', { headers });
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.revision).toBe(17);
    expect(body.pages.slice(0,2).map((p: { id: string }) => p.id)).toEqual(['idx-b', 'idx-a']);
    expect(body.trash).toEqual([{ id: 'idx-trash' }]);
    expect(body.access['idx-deleted']).toBeUndefined();
    expect(body.access.hidden).toBeUndefined();
    expect(body.access.public.level).toBe('view');
  });

  it('serializes competing saves, preserves numeric JSON and acknowledges a lost response', async () => {
    const path = '/internal/documents/public';
    const journal = { Authorization: 'Bearer ' + secret, 'Blok-Doc-Version': '0', 'Blok-Doc-Lineage': 'L', 'Blok-Doc-Sequence': '1' };
    const put = (body: string) => app.request(path, { method: 'PUT', headers: journal, body });
    const bodies = ['{"integer":9007199254740993}', '{"integer":9007199254740995}'];
    const statuses = await Promise.all(bodies.map(async (body) => (await put(body)).status));
    expect([...statuses].sort()).toEqual([200, 409]);
    const winner = bodies[statuses.indexOf(200)]!;
    expect(await (await put(winner)).json()).toEqual({ version: '1' });
    const stored = await app.request(path, { headers: journal });
    expect((await stored.text()).replaceAll(' ', '')).toBe(`{"data":${winner},"version":"1"}`);
  });
});
