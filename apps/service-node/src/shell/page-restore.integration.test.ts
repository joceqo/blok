import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {Hono} from 'hono';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {hashSecret} from '../auth/codes.ts';
import {registerTrashRestore} from './page-restore.ts';
import {WorkspaceError} from './workspace-scope.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('restore a single entry from the canonical trash', () => {
  const schema = 'restore_' + randomUUID().replaceAll('-','');
  const admin = new pg.Pool({connectionString:url});
  const db = new pg.Pool({connectionString:url,options:'-csearch_path='+schema});
  const app = new Hono();
  app.onError((err,c) => c.json({error:err.message},err instanceof WorkspaceError ? err.status : 500));
  registerTrashRestore(app, db);
  const restore = (id:string, revision:number, user='admin') => app.request('/api/workspaces/ws/pages/'+id+'/restore-from-trash',{
    method:'POST',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json'},body:JSON.stringify({revision}),
  });
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA '+schema);
    await db.query(await readFile(new URL('../../../service/schema.sql',import.meta.url),'utf8'));
    await db.query("INSERT INTO workspaces(id,slug,name) VALUES('w','ws','Atelier')");
    for(const role of ['admin','member','viewer']) {
      await db.query("INSERT INTO users(id,email) VALUES($1,$1||'@example.test')",[role]);
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashSecret(role),role]);
      await db.query("INSERT INTO memberships VALUES('w',$1,$1)",[role]);
    }
    await db.query(`INSERT INTO pages(id,workspace_id,metadata,content,visibility,trashed) VALUES
      ('parent','w','{"id":"parent","title":"Dossier","position":3}','{"blocks":[{"id":"original"}]}','workspace',true),
      ('child','w','{"id":"child","parentId":"parent"}',null,'inherit',true),
      ('hidden','w','{"id":"hidden"}',null,'private',false),
      ('detached','w','{"id":"detached","parentId":"hidden"}',null,'inherit',true),
      ('private','w','{"id":"private"}',null,'private',true),
      ('other','w','{"id":"other"}',null,'workspace',true)`);
    await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('detached','member','full','admin')");
  });
  afterAll(async () => {
    await db.end(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end();
  });
  it('preserves page data and children and rechecks hierarchy, permission and concurrent revisions', async () => {
    expect((await restore('parent',0,'viewer')).status).toBe(403);
    expect((await restore('parent',0,'member')).status).toBe(403);
    expect((await restore('private',0)).status).toBe(404);
    expect((await restore('detached',0,'member')).status).toBe(409);
    expect((await restore('child',0)).status).toBe(409);
    expect((await restore('parent',1)).status).toBe(409);
    const page = async () => (await db.query("SELECT metadata,content,visibility,trashed FROM pages WHERE id='parent'")).rows[0];
    const original = await page();
    expect(await (await restore('parent',0)).json()).toEqual({restored:'parent',revision:1});
    expect(await page()).toEqual({...original,trashed:false});
    expect((await db.query("SELECT trashed FROM pages WHERE id='child'")).rows[0].trashed).toBe(true);
    expect((await restore('parent',1)).status).toBe(409);
    const results = await Promise.all([restore('child',1),restore('other',1)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await db.query("SELECT revision FROM workspaces WHERE id='w'")).rows[0].revision).toBe('2');
  });
});
