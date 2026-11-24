import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShellApp } from './app.js';

const databaseUrl = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('workspace membership on canonical PostgreSQL', () => {
  const schema = 'members_' + randomUUID().replaceAll('-', '');
  const owner = new pg.Pool({ connectionString: databaseUrl });
  const db = new pg.Pool({ connectionString: databaseUrl, options: '-csearch_path=' + schema });
  const recheck = vi.fn(async (_workspace: string) => {});
  const app = createShellApp(db, 's'.repeat(32), new Set(), recheck);
  function api(actor: string, method = 'GET', target = '', body?: object, slug = 'demo') {
    return app.request('/api/workspaces/' + slug + '/members' + (target ? '/' + target : ''), {
      method, headers: { Authorization: 'Bearer ' + actor }, body: body && JSON.stringify(body),
    });
  }
  beforeAll(async () => {
    await owner.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
    await db.query(`INSERT INTO users(id,email) SELECT id,id||'@test' FROM unnest(ARRAY['a','b','v','c']) id;
      INSERT INTO workspaces(id,slug,name) VALUES ('one','demo','D'),('other','one','O');
      INSERT INTO pages(id,workspace_id,metadata) VALUES ('p','one','{}'),('q','other','{}')`);
    for (const user of ['a','b','c','v']) {
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
        [createHash('sha256').update(user).digest('hex'),user]);
    }
  });
  beforeEach(async () => {
    recheck.mockClear();
    await db.query(`TRUNCATE page_shares; DELETE FROM memberships;
      INSERT INTO memberships VALUES ('one','a','admin'),('one','b','admin'),('one','v','viewer'),('other','c','admin'),('other','v','member');
      INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES ('p','v','view','a'),('q','v','edit','c')`);
  });
  afterAll(async () => {
    await db.end();
    try { await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
    finally { await owner.end(); }
  });
  it('lists only workspace members, resolving a matching slug before a competing ID', async () => {
    const members = await (await api('v')).json();
    expect(members.members.map((m: {id:string}) => m.id)).toEqual(['a','b','v']);
    expect((await api('a','GET','',undefined,'one')).status).toBe(403);
    expect((await api('c','GET','',undefined,'other')).status).toBe(200);
    expect((await api('expired')).status).toBe(401);
    expect((await api('v','PATCH','a',{role:'member'})).status).toBe(403);
    expect((await api('a','PATCH','v',{role:'owner'})).status).toBe(400);
    expect((await api('a','PATCH','c',{role:'viewer'})).status).toBe(404);
    expect(recheck).not.toHaveBeenCalled();
  });
  it('keeps an administrator during concurrent self-demotions', async () => {
    const results = await Promise.all(['a','b'].map(u => api(u,'PATCH',u,{role:'member'})));
    expect(results.map(r => r.status).sort()).toEqual([200,409]);
    expect(recheck).toHaveBeenCalledTimes(1);
  });
  it('removes only this workspace’s shares and reports a post-commit refresh failure', async () => {
    recheck.mockRejectedValueOnce(new Error('host unavailable'));
    const response = await api('a','DELETE','v');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error:'Membership saved, live access refresh failed' });
    expect((await api('v')).status).toBe(403);
    expect((await db.query("SELECT page_id FROM page_shares WHERE user_id='v'")).rows).toEqual([{page_id:'q'}]);
  });
});
