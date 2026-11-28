import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { calendarSharing } from './calendar-sharing.ts';
import { WorkspaceError } from './workspace-scope.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('opt-in calendar availability on PostgreSQL', () => {
  const schema = 'sharing_' + randomUUID().replaceAll('-', '');
  const owner = new pg.Pool({connectionString: url});
  const pool = new pg.Pool({connectionString: url, options: '-csearch_path=' + schema});
  const remote = vi.fn(async (_workspace: string, _user: string, from: string, to: string) => [{start: from, end: to}]);
  const app = new Hono();
  app.onError((e, c) => {
    if (e instanceof WorkspaceError || e instanceof HTTPException) return c.json({error:e.message}, e.status);
    throw e;
  });
  app.route('/spaces/:slug', calendarSharing(pool, remote));
  const dates = '?from=2026-11-24T00:00:00Z&to=2026-11-27T00:00:00Z';
  const read = (user: string, path: string, slug = 'alpha') => app.request('/spaces/' + slug + path, { headers: {Authorization:'Bearer '+user} });
  const sharing = (user: string, enabled: boolean) => app.request('/spaces/alpha/sharing', {
    method:'PUT', body: JSON.stringify({enabled}), headers: {Authorization:'Bearer '+user},
  });
  beforeAll(async () => {
    await owner.query('CREATE SCHEMA ' + schema);
    await pool.query(await readFile(process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
    await pool.query(`INSERT INTO users(id,email,name) SELECT id,id||'@example.test',id FROM unnest(ARRAY['cam','jo','other']) id;
      INSERT INTO workspaces(id,slug,name) VALUES ('a','alpha','Alpha'),('b','beta','Beta');
      INSERT INTO memberships VALUES ('a','cam','member'),('a','jo','viewer'),('b','other','admin'),('b','cam','member');`);
    for (const user of ['cam','jo','other']) {
      await pool.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
        [createHash('sha256').update(user).digest('hex'),user]);
    }
  });
  afterAll(async () => {
    await pool.end();
    try { await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); } finally { await owner.end(); }
  });

  it('defaults to private and scopes opt-in to the owner, viewer and workspace', async () => {
    expect(await (await read('jo','/members')).json()).toEqual({sharing:false,members:[]});
    expect((await read('jo','/members/cam/freebusy'+dates)).status).toBe(404);
    expect((await read('other','/members')).status).toBe(403);
    expect(remote).not.toHaveBeenCalled();
    expect((await sharing('cam',true)).status).toBe(200);
    expect(await (await read('cam','/members')).json()).toEqual({sharing:true,members:[]});
    expect(await (await read('jo','/members')).json()).toEqual({sharing:false,members:[{id:'cam',name:'cam'}]});
    expect((await read('other','/members/cam/freebusy'+dates,'beta')).status).toBe(404);
    expect((await read('jo','/members/cam/freebusy?from=2026-01-01T00:00:00Z&to=2026-11-27T00:00:00Z')).status).toBe(400);
    const shared = await read('jo','/members/cam/freebusy'+dates);
    expect(shared.headers.get('Cache-Control')).toContain('no-store');
    expect(await shared.json()).toEqual({busy:[{start:'2026-11-24T00:00:00.000Z',end:'2026-11-27T00:00:00.000Z'}]});
    expect(remote).toHaveBeenCalledOnce();
    await sharing('cam',false);
  });

  it('discards an in-flight response when the owner revokes or leaves, including after rejoining', async () => {
    for (const revoke of ['opt-out','leave']) {
      await sharing('cam',true);
      let ready!: () => void;
      const providerStarted = new Promise<void>(resolve => { ready = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      remote.mockImplementationOnce(async (_w,_u,from,to) => {
        ready();
        await gate;
        return [{start:from,end:to}];
      });
      const waiting = read('jo','/members/cam/freebusy'+dates);
      await providerStarted;
      try {
        if (revoke === 'opt-out') await sharing('cam',false);
        else {
          await pool.query("DELETE FROM memberships WHERE workspace_id='a' AND user_id='cam'");
          await pool.query("INSERT INTO memberships VALUES ('a','cam','member')");
        }
      } finally { release(); }
      expect((await waiting).status).toBe(404);
      expect(await (await read('jo','/members')).json()).toEqual({sharing:false,members:[]});
    }
  });
});
