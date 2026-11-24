import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShellApp } from './app.js';

const databaseUrl = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('teamspace directory on the canonical shell schema', () => {
  const schema = 'test_teams_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const db = new pg.Pool({ connectionString: databaseUrl, options: '-csearch_path=' + schema });
  const app = createShellApp(db, 't'.repeat(32), new Set());

  function call(path = '', method = 'GET', body?: object, user = 'member', workspace = 'demo') {
    return app.request('/api/workspaces/' + workspace + '/teamspaces' + path, {
      method, headers: { Authorization: 'Bearer ' + user }, body: body && JSON.stringify(body),
    });
  }
  async function create(name: string) {
    const response = await call('', 'POST', { name });
    expect(response.status).toBe(201);
    const { teamspace } = await response.json();
    expect(teamspace).toEqual({ id: expect.any(String), name: name.trim(), workspaceId: 'w', createdAt: expect.any(String) });
    return teamspace.id as string;
  }
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    const sql = await readFile(new URL('../../../service/schema.sql', import.meta.url), 'utf8');
    await db.query(sql);
    await db.query(sql); // The Go service reapplies the entire schema on startup.
    const versions = await db.query('SELECT max(version) AS current FROM schema_migrations');
    expect(versions.rows).toEqual([{ current: 7 }]);
    await db.query(`INSERT INTO users(id,email) SELECT id,id || '@test.invalid' FROM unnest(ARRAY['member','admin','reader','outsider']) id;
      INSERT INTO workspaces(id,slug,name) VALUES ('w','demo','Demo'),('z','other','Other');
      INSERT INTO memberships VALUES ('w','admin','admin'),('w','member','member'),('w','reader','viewer'),('z','outsider','member')`);
    for (const id of ['member','admin','reader','outsider']) {
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [createHash('sha256').update(id).digest('hex'),id]);
    }
  });
  afterAll(async () => {
    await db.end();
    try { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
    finally { await admin.end(); }
  });

  it('creates, renames, lists and deletes with the #46 response shapes', async () => {
    const id = await create('  Product  ');
    const path = '/' + id;
    expect((await call(path, 'PATCH', { name: '  ' })).status).toBe(400);
    const changed = await call(path, 'PATCH', { name: ' Engineering ' }, 'admin');
    expect(await changed.json()).toMatchObject({ teamspace: { id, name:'Engineering' } });
    const listed = await call('', 'GET', undefined, 'reader');
    expect((await listed.json()).teamspaces).toContainEqual(expect.objectContaining({ id, name:'Engineering' }));
    const removed = await call(path, 'DELETE');
    expect(await removed.json()).toEqual({ ok: true });
    expect((await call(path, 'DELETE')).status).toBe(404);
  });

  it('honors admission, role caps and validation', async () => {
    expect((await call('', 'POST', { name:'X' }, 'expired')).status).toBe(401);
    expect((await call('', 'GET', undefined, 'outsider')).status).toBe(404);
    const refused = await call('', 'POST', { name:'X' }, 'reader');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error:'permission_denied',action:'edit' });
    expect((await call('', 'POST', { name:' ' })).status).toBe(400);
  });

  it('lists sorted membership, handles racing adds, deletes and cascades on team deletion', async () => {
    const id = await create('Design');
    const path = '/' + id + '/members';
    const added = await Promise.all([1,2].map(() => call(path, 'POST', { userId:'reader' })));
    expect(added.map(r => r.status).sort()).toEqual([201,409]);
    expect(await added.find(r => r.status === 201)!.json()).toEqual({member:{userId:'reader',email:'reader@test.invalid'}});
    await call(path,'POST',{userId:'admin'});
    const listed = await call(path);
    expect((await listed.json()).members.map((m: {userId:string}) => m.userId)).toEqual(['admin','reader']);
    expect((await call(path,'POST',{userId:'outside/member'})).status).toBe(400);
    expect(await (await call(path,'POST',{userId:'outsider'})).json()).toEqual({error:'not_workspace_member'});
    expect((await call(path+'/reader','DELETE')).status).toBe(200);
    expect((await call(path+'/reader','DELETE')).status).toBe(404);
    expect((await call('/'+id,'DELETE')).status).toBe(200);
    expect((await db.query('SELECT 1 FROM teamspace_members WHERE teamspace_id=$1',[id])).rowCount).toBe(0);
  });

  it('attaches and detaches an existing page without changing its rights or document', async () => {
    const team = await create('Design');
    const pages = '/' + team + '/pages';
    await db.query(`INSERT INTO pages(id,workspace_id,metadata,visibility) VALUES
      ('private-folder','w','{}','private'),
      ('design-note','w','{"title":"Design notes","parentId":"private-folder"}','inherit'),
      ('other-note','z','{}','workspace');
      INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('private-folder','member','edit','admin')`);
    const link = pages + '/design-note';
    expect((await call(link,'PUT')).status).toBe(200);
    expect((await call(link,'PUT')).status).toBe(200);
    expect(await (await call(pages)).json()).toEqual({pages:[{id:'design-note',title:'Design notes'}]});
    expect(await (await call(pages,'GET',undefined,'reader')).json()).toEqual({pages:[]});
    expect((await call(link,'PUT',undefined,'admin')).status).toBe(404);
    expect((await call(pages+'/other-note','PUT')).status).toBe(404);
    await db.query("UPDATE page_shares SET level='view' WHERE page_id='private-folder'");
    expect((await call(link,'DELETE')).status).toBe(403);
    await db.query("UPDATE pages SET trashed=true WHERE id='design-note'");
    expect(await (await call(pages)).json()).toEqual({pages:[]});
    await db.query("UPDATE pages SET trashed=false WHERE id='design-note'; UPDATE page_shares SET level='edit' WHERE page_id='private-folder'");
    expect((await call(link,'DELETE')).status).toBe(200);
    expect((await call(link,'DELETE')).status).toBe(200);
    expect(await (await call(pages)).json()).toEqual({pages:[]});
    expect((await db.query("SELECT id FROM pages WHERE id='design-note' AND NOT deleted")).rowCount).toBe(1);
    await expect(db.query('INSERT INTO teamspace_pages VALUES($1,$2,$3)', ['w',team,'other-note'])).rejects.toMatchObject({ code:'23503' });
  });

  it('enforces both workspace relations even on direct SQL writes', async () => {
    const id = await create('Operations');
    await expect(db.query('INSERT INTO teamspace_members VALUES($1,$2,$3)', ['z',id,'outsider'])).rejects.toMatchObject({ code:'23503' });
    await expect(db.query('INSERT INTO teamspace_members VALUES($1,$2,$3)', ['w',id,'outsider'])).rejects.toMatchObject({ code:'23503' });
    await db.query("INSERT INTO users(id,email) VALUES('departed','departed@test'); INSERT INTO memberships VALUES('w','departed','member')");
    await call('/'+id+'/members','POST',{userId:'departed'});
    await db.query("DELETE FROM memberships WHERE workspace_id='w' AND user_id='departed'; DELETE FROM users WHERE id='departed'");
    expect(await (await call('/'+id+'/members')).json()).toEqual({members:[]});
  });
});
