import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createShellApp } from './app.js';

const databaseUrl = process.env.SHELL_TEST_DATABASE_URL;
const schemaPath = process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url);

describe.skipIf(!databaseUrl)('teamspace, workspace and page permissions on PostgreSQL', () => {
  const schema = 'test_team_acl_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const db = new pg.Pool({ connectionString: databaseUrl, options: '-csearch_path=' + schema });
  const app = createShellApp(db, 'a'.repeat(32), new Set(), async () => {});
  const teamspace = '/teamspaces';
  const page = '/pages/private-page';
  let roster: string;

  function request(user: string, path: string, method = 'GET', body?: object, workspace = 'alpha') {
    return app.request('/api/workspaces/' + workspace + path, {
      method,
      headers: { Authorization: 'Bearer token-' + user, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(schemaPath, 'utf8'));
  });

  afterAll(async () => {
    await db.end();
    try { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
    finally { await admin.end(); }
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users, workspaces CASCADE;
      INSERT INTO users(id,email) VALUES ('owner','owner@test'),('member','member@test'),('reader','reader@test'),('other','other@test');
      INSERT INTO workspaces(id,slug,name) VALUES ('w1','alpha','Alpha'),('w2','beta','Beta');
      INSERT INTO memberships(workspace_id,user_id,role) VALUES
        ('w1','owner','admin'),('w1','member','member'),('w1','reader','viewer'),
        ('w2','owner','admin'),('w2','member','member'),('w2','other','member');
      INSERT INTO pages(id,workspace_id,metadata,visibility,content) VALUES
        ('private-page','w1','{"id":"private-page","title":"Private"}','private','{"blocks":[]}'),
        ('other-page','w2','{"id":"other-page","title":"Other"}','workspace','{"blocks":[]}');
      INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES ('private-page','owner','full','owner')`);
    for (const user of ['owner', 'member', 'reader', 'other']) {
      const digest = createHash('sha256').update('token-' + user).digest('hex');
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [digest,user]);
    }

    const created = await request('owner', teamspace, 'POST', { name: 'Design' });
    expect(created.status).toBe(201);
    const { teamspace: team } = await created.json();
    roster = teamspace + '/' + team.id + '/members';
  });

  it('requires a page grant independently of team membership, and applies revocation immediately', async () => {
    expect((await request('owner', roster, 'POST', { userId: 'member' })).status).toBe(201);
    const index = () => request('member', '/index').then(r => r.json());
    expect((await index()).pages).toEqual([]);
    expect((await request('member', page)).status).toBe(404);
    expect((await request('member', page + '/access')).status).toBe(404);

    expect((await request('owner', page + '/shares/member', 'PUT', { level: 'edit' })).status).toBe(200);
    expect((await index()).access['private-page'].level).toBe('edit');
    expect((await request('member', page)).status).toBe(200);
    expect((await request('owner', page + '/shares/member', 'DELETE')).status).toBe(200);
    expect((await request('member', page)).status).toBe(404);
    expect((await (await request('member', roster)).json()).members).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: 'member' })]));
  });

  it('checks current workspace membership even with a valid session and an existing direct page grant', async () => {
    expect((await request('owner', roster, 'POST', { userId: 'member' })).status).toBe(201);
    expect((await request('owner', page + '/shares/member', 'PUT', { level: 'full' })).status).toBe(200);
    expect((await request('member', page)).status).toBe(200);
    // Keep the grant in place deliberately. Neither the session nor a stale grant
    // can replace workspace membership, even when an old grant remains.
    await db.query("DELETE FROM memberships WHERE workspace_id='w1' AND user_id='member'");
    for (const path of [teamspace, roster]) {
      expect((await request('member', path)).status, path).toBe(404);
    }
    for (const path of ['/index', page, page + '/access']) {
      expect((await request('member', path)).status, path).toBe(403);
    }
    expect((await db.query("SELECT 1 FROM teamspace_members WHERE workspace_id='w1' AND user_id='member'")).rowCount).toBe(0);
    expect((await request('member', '/pages/other-page', 'GET', undefined, 'beta')).status).toBe(200);
  });

  it('removes page and team grants on departure and leaves the other workspace intact on readmission', async () => {
    expect((await request('owner', roster, 'POST', { userId: 'member' })).status).toBe(201);
    expect((await request('owner', page + '/shares/member', 'PUT', { level: 'edit' })).status).toBe(200);
    expect((await request('owner', '/members/member', 'DELETE')).status).toBe(200);
    expect((await request('member', page)).status).toBe(403);
    expect((await request('member', '/pages/other-page', 'GET', undefined, 'beta')).status).toBe(200);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ('w1','member','member')");
    expect((await request('member', page)).status).toBe(404);
    expect((await (await request('member', '/index')).json()).pages).toEqual([]);
    expect((await (await request('owner', roster)).json()).members).toEqual([]);
  });

  it('isolates team rosters, page IDs and member targets across workspaces', async () => {
    expect((await request('owner', roster, 'GET', undefined, 'beta')).status).toBe(404);
    expect((await request('owner', roster, 'POST', { userId: 'member' }, 'beta')).status).toBe(404);
    expect((await request('owner', page, 'GET', undefined, 'beta')).status).toBe(404);
    expect((await request('owner', page + '/access', 'GET', undefined, 'beta')).status).toBe(404);
    expect((await request('owner', page + '/shares/member', 'PUT', { level: 'full' }, 'beta')).status).toBe(404);
    expect((await request('owner', roster, 'POST', { userId: 'other' })).status).toBe(400);
    expect((await request('owner', page + '/shares/other', 'PUT', { level: 'full' })).status).toBe(404);
    expect((await db.query("SELECT 1 FROM teamspace_members WHERE user_id='other'")).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM page_shares WHERE user_id='other'")).rowCount).toBe(0);
  });

  it('accepts workspace IDs and resolves a matching slug before checking membership', async () => {
    for (const path of [teamspace, roster, '/index', page, page + '/access']) {
      expect((await request('owner', path, 'GET', undefined, 'w1')).status, path).toBe(200);
    }
    const index = await (await request('owner', '/index')).json();
    expect((await request('owner', '/index', 'PUT', index, 'w1')).status).toBe(200);
    await db.query("INSERT INTO workspaces(id,slug,name) VALUES ('third','w1','Third')");
    expect((await request('owner', teamspace, 'GET', undefined, 'w1')).status).toBe(404);
    for (const path of ['/index', page, page + '/access']) {
      expect((await request('owner', path, 'GET', undefined, 'w1')).status, path).toBe(403);
    }
    expect((await request('owner', '/index', 'PUT', index, 'w1')).status).toBe(403);
    expect((await request('owner', page)).status).toBe(200);
  });

  it('keeps viewer actions read-only even with a full page grant and a roster entry', async () => {
    expect((await request('owner', roster, 'POST', { userId: 'reader' })).status).toBe(201);
    expect((await request('owner', page + '/shares/reader', 'PUT', { level: 'full' })).status).toBe(200);
    expect((await request('reader', roster)).status).toBe(200);
    expect((await (await request('reader', page + '/access')).json()).myLevel).toBe('view');
    const index = await (await request('reader', '/index')).json();
    expect(index.access['private-page'].level).toBe('view');
    expect((await request('reader', '/index', 'PUT', { ...index, pages: [] })).status).toBe(403);
    expect((await request('reader', page + '/access', 'PUT', { visibility: 'workspace' })).status).toBe(403);
    expect((await request('reader', page + '/shares/member', 'PUT', { level: 'edit' })).status).toBe(403);
    expect((await request('reader', teamspace, 'POST', { name: 'Another' })).status).toBe(403);
    expect((await request('reader', roster, 'POST', { userId: 'member' })).status).toBe(403);
    expect((await request('reader', roster + '/reader', 'DELETE')).status).toBe(403);
    expect((await request('owner', page)).status).toBe(200);
  });
});
