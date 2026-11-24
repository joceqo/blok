import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShellApp } from './app.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('shared calendar on PostgreSQL', () => {
  const schema = 'calendar_' + randomUUID().replaceAll('-', '');
  const owner = new pg.Pool({connectionString: url});
  const db = new pg.Pool({connectionString: url, options: '-csearch_path=' + schema});
  const app = createShellApp(db, 'k'.repeat(32), new Set());
  const range = '?from=2026-03-22T23:00:00Z&to=2026-03-29T22:00:00Z&fromDate=2026-03-23&toDate=2026-03-30';
  const make = () => ({id:randomUUID(), title:'Point équipe', allDay:false, start:'2026-03-29T21:00:00.000Z', end:'2026-03-29T22:00:00.000Z', pageId:null as string | null, revision:0});
  const call = (user: string, method: string, path: string, body?: unknown, space = 'alpha') => app.request('/api/workspaces/' + space + '/calendar' + path,
    {method, headers:{Authorization:'Bearer '+user}, body: body ? JSON.stringify(body) : undefined});
  const list = async (user: string) => {
    const res = await call(user, 'GET', range);
    expect(res.status).toBe(200);
    return (await res.json()).events as Array<ReturnType<typeof make>>;
  };
  beforeAll(async () => {
    await owner.query('CREATE SCHEMA ' + schema);
    const sql = await readFile(process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url), 'utf8');
    await db.query(sql);
    await db.query(sql);
    await db.query(`INSERT INTO users(id,email) SELECT id,id||'@example.test' FROM unnest(ARRAY['owner','member','viewer','outside']) id;
      INSERT INTO workspaces(id,slug,name) VALUES('a','alpha','Alpha'),('b','beta','Beta');
      INSERT INTO memberships VALUES ('a','owner','admin'),('a','viewer','viewer'),('a','member','member'),('b','outside','admin');
      INSERT INTO pages(id,workspace_id,metadata,visibility) VALUES('parent','a','{}','private'),('child','a','{"parentId":"parent"}','inherit'),('alien','b','{}','workspace');
      INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('parent','owner','full','owner');`);
    for (const id of ['owner','member','viewer','outside']) await db.query(
      "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [createHash('sha256').update(id).digest('hex'),id]);
  });
  afterAll(async () => {
    await db.end();
    try { await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); } finally { await owner.end(); }
  });

  it('shares events, prevents lost updates and cross-workspace mutations, and respects floating-day boundaries', async () => {
    const e = make(), write = (event: typeof e) => call('member','PUT','/'+event.id,event);
    const created = await write(e);
    expect(await created.json()).toEqual({event:{...e,revision:1}});
    expect(await list('viewer')).toContainEqual({...e,revision:1});
    const results = await Promise.all(['A','B'].map(title => write({...e,title,revision:1})));
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await call('member','DELETE','/'+e.id+'?revision=1')).status).toBe(409);
    expect((await call('outside','DELETE','/'+e.id+'?revision=2',undefined,'beta')).status).toBe(404);
    expect((await call('viewer','DELETE','/'+e.id+'?revision=2')).status).toBe(403);
    expect((await call('member','DELETE','/'+e.id+'?revision=2')).status).toBe(200);
    expect((await write({...e, revision:2})).status).toBe(404);
    const before = {...make(),allDay:true,start:'2026-03-22',end:'2026-03-23'};
    const inside = {...make(),allDay:true,start:'2026-03-29',end:'2026-03-30'};
    const after = {...make(),start:'2026-03-29T22:00:00Z',end:'2026-03-29T23:00:00Z'};
    for (const item of [before,inside,after]) expect((await write(item)).status).toBe(200);
    const events = await list('member');
    expect(events).toContainEqual({...inside,revision:1});
    expect(events.map(item=>item.id)).not.toContain(before.id);
    expect(events.map(item=>item.id)).not.toContain(after.id);
    expect((await call('outside','GET',range)).status).toBe(403);
  });

  it('reevaluates page visibility for the event title, mutations, and previously granted links', async () => {
    const e = {...make(),title:'Conseil privé',pageId:'child'};
    const send = (user: string, event: ReturnType<typeof make>) => call(user,'PUT','/'+event.id,event);
    expect((await send('member',e)).status).toBe(404);
    expect((await send('owner',{...e,pageId:'alien'})).status).toBe(404);
    expect((await send('owner',e)).status).toBe(200);
    expect((await list('member')).some(item=>item.id===e.id)).toBe(false);
    expect((await send('member',{...e,revision:1,pageId:null})).status).toBe(404);
    expect((await call('member','DELETE','/'+e.id+'?revision=1')).status).toBe(404);
    await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('parent','member','view','owner')");
    expect(await list('member')).toContainEqual({...e,revision:1});
    await db.query("DELETE FROM page_shares WHERE user_id='member'");
    expect((await list('member')).some(item=>item.id===e.id)).toBe(false);
    await db.query("UPDATE pages SET trashed=true WHERE id='child'");
    expect((await list('owner')).some(item=>item.id===e.id)).toBe(false);
  });
});
