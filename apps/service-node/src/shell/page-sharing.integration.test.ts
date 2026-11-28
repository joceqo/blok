import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShellApp } from './app.ts';

const databaseUrl = process.env.SHELL_TEST_DATABASE_URL;
const schemaPath = process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url);
describe.skipIf(!databaseUrl)('canonical page sharing on PostgreSQL', () => {
  const schema = 'test_sharing_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const db = new pg.Pool({ connectionString: databaseUrl, options: '-csearch_path=' + schema });
  const recheck = vi.fn(async (_workspace: string) => {});
  const app = createShellApp(db, 'a'.repeat(32), new Set(), recheck);

  function send(user: string, page: string, endpoint = 'access', method = 'GET', body?: object, workspace = 'demo') {
    return app.request('/api/workspaces/' + workspace + '/pages/' + page + '/' + endpoint, {
      method, headers: { Authorization: 'Bearer ' + user }, body: body && JSON.stringify(body),
    });
  }
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(schemaPath, 'utf8'));
    await db.query(`INSERT INTO users(id,email) SELECT id,id||'@test' FROM unnest(ARRAY['owner','editor','viewer','admin','outside']) id;
      INSERT INTO workspaces(id,slug,name) VALUES ('w','demo','Demo'),('z','other','Other');
      INSERT INTO memberships VALUES ('w','owner','member'),('w','editor','member'),('w','viewer','viewer'),('w','admin','admin'),('z','owner','admin');
      INSERT INTO pages(id,workspace_id,metadata,visibility,deleted) VALUES
        ('root','w','{}','private',false),('child','w','{"parentId":"root"}','inherit',false),
        ('public','w','{}','workspace',false),('other-page','z','{}','workspace',false),
        ('foreign-parent','w','{"parentId":"other-page"}','inherit',false),('deleted','w','{}','workspace',true)`);
    for (const u of ['owner','editor','viewer','admin','outside']) {
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [createHash('sha256').update(u).digest('hex'),u]);
    }
  });
  afterAll(async () => {
    await db.end();
    try { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
    finally { await admin.end(); }
  });
  beforeEach(async () => {
    recheck.mockClear();
    await db.query(`TRUNCATE page_shares;
      UPDATE pages SET visibility='private' WHERE id='root';
      INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES
        ('root','owner','full','owner'),('root','viewer','full','owner'),('child','editor','edit','owner')`);
  });
  it('separates local and inherited grants, sorts by email and caps viewer access', async () => {
    const result = await send('viewer','child');
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      visibility:'inherit', effectiveVisibility:'private', myLevel:'view',
      shares:[{ userId:'editor',email:'editor@test',level:'edit' }],
      inherited:[{ from:'root',userId:'owner',email:'owner@test',level:'full' },{ from:'root',userId:'viewer',email:'viewer@test',level:'full' }],
    });
    expect((await send('viewer','child','shares/editor','DELETE')).status).toBe(403);
    expect((await send('editor','child','access','PUT',{visibility:'workspace'})).status).toBe(403);
    expect(recheck).not.toHaveBeenCalled();
  });
  it('checks session, workspace membership and every ancestor against the requested workspace', async () => {
    expect((await send('unknown','root')).status).toBe(401);
    expect((await send('owner','root','access','GET',undefined,'missing')).status).toBe(404);
    expect((await send('outside','root')).status).toBe(403);
    for (const page of ['deleted','foreign-parent','other-page']) {
      expect((await send('owner',page)).status).toBe(404);
      expect((await send('owner',page,'shares/owner','PUT',{level:'full'})).status).toBe(404);
    }
    expect((await send('owner','root','access','GET',undefined,'w')).status).toBe(200);
    expect((await send('admin','root')).status).toBe(404);
    expect(recheck).not.toHaveBeenCalled();
  });
  it('accepts valid changes and notifies the live host after all writes have committed', async () => {
    recheck.mockImplementationOnce(async workspace => {
      expect(workspace).toBe('w');
      expect((await db.query("SELECT level FROM page_shares WHERE page_id='root' AND user_id='editor'")).rows).toEqual([{level:'full'}]);
    });
    expect((await send('owner','root','shares/editor','PUT',{level:'full'})).status).toBe(200);
    expect((await (await send('editor','child')).json()).myLevel).toBe('full');
    expect((await send('owner','root','shares/editor','DELETE')).status).toBe(200);
    expect((await send('editor','root')).status).toBe(404);
    expect((await send('owner','root','access','PUT',{visibility:'workspace'})).status).toBe(200);
    expect((await (await send('editor','root')).json()).myLevel).toBe('edit');
    expect((await send('owner','root','access','PUT',{visibility:'private'})).status).toBe(200);
    expect((await send('editor','root')).status).toBe(404);
    expect(recheck.mock.calls).toEqual([['w'],['w'],['w'],['w']]);
  });
  it('rejects non-members, invalid payloads and removing the last effective manager', async () => {
    expect((await send('owner','root','shares/outside','PUT',{level:'view'})).status).toBe(404);
    expect((await send('owner','root','shares/editor','PUT',{level:'writer'})).status).toBe(400);
    expect((await send('owner','root','access','PUT',{visibility:'public'})).status).toBe(400);
    expect((await send('owner','root','shares/owner','DELETE')).status).toBe(409);
    expect((await send('owner','root','shares/owner','PUT',{level:'edit'})).status).toBe(409);
    expect((await send('admin','public','access','PUT',{visibility:'private'})).status).toBe(409);
    expect((await (await send('owner','root')).json()).myLevel).toBe('full');
    expect(recheck).not.toHaveBeenCalled();
  });
  it('permits removal of a direct grant if the same person retains inherited full access', async () => {
    expect((await send('owner','child','shares/owner','PUT',{level:'full'})).status).toBe(200);
    expect((await send('owner','child','shares/owner','DELETE')).status).toBe(200);
    expect((await (await send('owner','child')).json()).myLevel).toBe('full');
  });
  it('serializes racing removals across separate PostgreSQL connections', async () => {
    await send('owner','root','shares/editor','PUT',{level:'full'});
    const removals = await Promise.all(['owner','editor'].map(u => send(u,'root','shares/'+u,'DELETE')));
    expect(removals.map(r => r.status).sort()).toEqual([200,409]);
    expect((await db.query("SELECT count(*)::int AS count FROM page_shares WHERE page_id='root' AND level='full' AND user_id IN ('owner','editor')")).rows).toEqual([{count:1}]);
  });
  it('returns failure when committed access could not be broadcast', async () => {
    recheck.mockRejectedValueOnce(new Error('callback offline'));
    expect((await send('owner','root','shares/editor','PUT',{level:'view'})).status).toBe(503);
    expect((await send('editor','root')).status).toBe(200);
    expect((await send('owner','root','shares/editor','PUT',{level:'view'})).status).toBe(200);
  });
});
