import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShellApp } from './app.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!url)('workspace access notifications', () => {
  const schema = 'notifications_' + randomUUID().replaceAll('-', '');
  const owner = new pg.Pool({ connectionString: url });
  const db = new pg.Pool({ connectionString: url, options: '-csearch_path=' + schema });
  const app = createShellApp(db, 's'.repeat(32), new Set());
  const sql = readFile(process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url), 'utf8');

  function call(user: string, path: string, method = 'GET', body?: object, workspace = 'alpha') {
    return app.request('/api/workspaces/' + workspace + '/' + path, {
      method, headers: {Authorization: 'Bearer ' + user}, body: body && JSON.stringify(body),
    });
  }
  async function inbox(user: string, workspace = 'alpha') {
    const res = await call(user, 'notifications', 'GET', undefined, workspace);
    expect(res.status).toBe(200);
    return res.json();
  }
  beforeAll(async () => {
    await owner.query('CREATE SCHEMA ' + schema);
    await db.query(await sql);
    await db.query(`INSERT INTO users(id,email,name) SELECT id,id||'@example.test',id FROM unnest(ARRAY['owner','deputy','applicant','visitor']) id;
      INSERT INTO workspaces(id,slug,name) VALUES('a','alpha','Alpha'),('b','beta','Beta');
      INSERT INTO memberships VALUES('a','owner','admin'),('a','deputy','admin'),('b','visitor','admin');
      INSERT INTO join_requests(id,workspace_id,user_id) VALUES('old-request','b','applicant');
      DELETE FROM schema_migrations WHERE version=10;`);
    await db.query(await sql);
    await db.query(await sql);
    for (const id of ['owner','deputy','applicant','visitor']) {
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
        [createHash('sha256').update(id).digest('hex'), id]);
    }
  });
  afterAll(async () => {
    await db.end();
    try { await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
    finally { await owner.end(); }
  });
  it('backfills a pending request once on upgrade', async () => {
    expect(await inbox('visitor', 'beta')).toMatchObject({notifications:[{type:'join_requested',actorName:'applicant'}],unreadCount:1});
  });
  it('counts all unread decisions and keeps older unread entries reachable', async () => {
    await db.query(`INSERT INTO workspace_notifications(workspace_id,recipient_id,actor_id,type,created_at)
      SELECT 'b','deputy','visitor','join_rejected',now()-i*interval '1 minute' FROM generate_series(1,51) i`);
    const initial = await inbox('deputy','beta');
    expect(initial.unreadCount).toBe(51);
    expect(initial.notifications).toHaveLength(50);
    const id = initial.notifications[0].id;
    expect((await call('deputy','notifications/'+id+'/read','POST',undefined,'beta')).status).toBe(200);
    const more = await inbox('deputy','beta');
    expect(more.unreadCount).toBe(50);
    expect(more.notifications).toHaveLength(50);
    expect(more.notifications.every((n: {readAt: string | null}) => n.readAt === null)).toBe(true);
  });
  it('delivers a single notice per transition, isolates recipients, and rechecks admin membership', async () => {
    const submit = () => call('applicant', 'join-requests', 'POST', {});
    expect((await Promise.all([submit(), submit()])).map(r => r.status)).toEqual([200,200]);
    const admin = await inbox('owner');
    expect(admin).toMatchObject({notifications:[{type:'join_requested', actorName:'applicant',readAt:null}],unreadCount:1});
    const note = admin.notifications[0];
    const mark = (user: string, workspace = 'alpha') => call(user, 'notifications/' + note.id + '/read', 'POST', undefined, workspace);
    expect((await call('missing', 'notifications')).status).toBe(401);
    expect(await inbox('visitor')).toEqual({ notifications:[], unreadCount:0 });
    expect((await mark('visitor')).status).toBe(404);
    expect((await mark('owner','beta')).status).toBe(404);
    expect((await mark('deputy')).status).toBe(404);
    expect((await mark('owner')).status).toBe(200);
    const firstRead = (await inbox('owner')).notifications[0].readAt;
    expect(firstRead).toBeTypeOf('string');
    expect((await mark('owner')).status).toBe(200);
    expect(await inbox('owner')).toMatchObject({notifications:[{readAt:firstRead}],unreadCount:0});
    const other = (await inbox('deputy')).notifications[0];
    await db.query("UPDATE memberships SET role='member' WHERE user_id='deputy'");
    expect(await inbox('deputy')).toEqual({notifications:[],unreadCount:0});
    expect((await call('deputy','notifications/'+other.id+'/read','POST')).status).toBe(404);

    const {requests} = await (await call('owner', 'join-requests')).json();
    const decide = (action: string) => call('owner', 'join-requests/'+requests[0].id+'/'+action, 'POST', {});
    expect((await decide('reject')).status).toBe(200);
    expect((await decide('reject')).status).toBe(404);
    const declined = await inbox('applicant');
    expect(declined).toMatchObject({notifications:[{type:'join_rejected',actorName:'owner'}],unreadCount:1});
    expect((await call('applicant','notifications/'+declined.notifications[0].id+'/read','POST')).status).toBe(200);
    expect((await submit()).status).toBe(200);
    expect((await inbox('owner')).unreadCount).toBe(1);
    expect((await decide('approve')).status).toBe(200);
    expect((await inbox('applicant')).notifications.map((n: {type:string}) => n.type)).toEqual(['join_approved','join_rejected']);
    expect((await inbox('deputy')).notifications).toEqual([]);
    expect((await (await submit()).json()).status).toBe('approved');
  });
});
