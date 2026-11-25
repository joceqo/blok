import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {saveProjection} from './projection.ts';
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
  async function inbox(user: string, workspace = 'alpha', archived = false) {
    const res = await call(user, archived ? 'notifications?archived=1' : 'notifications', 'GET', undefined, workspace);
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
      INSERT INTO workspace_notifications(workspace_id,recipient_id,actor_id,type,created_at)
      VALUES ('b','visitor','owner','join_requested','2025-01-01'),
             ('b','owner','visitor','join_rejected','2025-01-02');
      DELETE FROM schema_migrations WHERE version IN (10,17);`);
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
  it('backfills a pending request and links recorded decisions once on upgrade', async () => {
    expect(await inbox('visitor', 'beta')).toMatchObject({notifications:[
      {type:'join_requested',actorName:'applicant'},
      {type:'join_requested',actorName:'owner',decision:{status:'rejected',isMe:true,actorName:'visitor'}},
    ],unreadCount:2});
  });
  it('counts and acknowledges all visible unread entries beyond the first page', async () => {
    await db.query(`INSERT INTO workspaces(id,slug,name) VALUES('g','gamma','Gamma');
      INSERT INTO workspace_notifications(workspace_id,recipient_id,actor_id,type)
      VALUES('g','deputy','visitor','join_rejected'),('b','deputy','applicant','join_requested')`);
    await db.query(`INSERT INTO workspace_notifications(workspace_id,recipient_id,actor_id,type,created_at)
      SELECT 'b','deputy','visitor','join_rejected',now()-i*interval '1 minute' FROM generate_series(1,53) i`);
    const initial = await inbox('deputy','beta');
    expect(initial.unreadCount).toBe(53);
    expect(initial.notifications).toHaveLength(50);
    const id = initial.notifications[0].id;
    expect((await call('deputy','notifications/'+id+'/read','POST',undefined,'beta')).status).toBe(200);
    const more = await inbox('deputy','beta');
    expect(more.unreadCount).toBe(52);
    expect(more.notifications).toHaveLength(50);
    expect(more.notifications.every((n: {readAt: string | null}) => n.readAt === null)).toBe(true);
    const markAll = (user:string) => call(user,'notifications/read-all','POST',undefined,'beta');
    expect((await markAll('missing')).status).toBe(401);
    const otherRecipient = (await inbox('visitor','beta')).unreadCount;
    expect((await markAll('deputy')).status).toBe(200);
    const after = await inbox('deputy','beta');
    expect(after.unreadCount).toBe(0);
    expect(after.notifications.every((n:{readAt:string|null})=>n.readAt)).toBe(true);
    expect((await markAll('deputy')).status).toBe(200);
    expect(await inbox('deputy','beta')).toEqual(after);
    expect((await inbox('deputy','gamma')).unreadCount).toBe(1);
    expect((await inbox('visitor','beta')).unreadCount).toBe(otherRecipient);
    const hidden = await db.query("SELECT read_at FROM workspace_notifications WHERE workspace_id='b' AND recipient_id='deputy' AND type='join_requested'");
    expect(hidden.rows).toEqual([{read_at:null}]);
  });
  it('delivers a single notice per transition, isolates recipients, and rechecks admin membership', async () => {
    const submit = (message = 'First request') => call('applicant', 'join-requests', 'POST', {message});
    expect((await Promise.all([submit(), submit()])).map(r => r.status)).toEqual([200,200]);
    const admin = await inbox('owner');
    expect(admin).toMatchObject({notifications:[{type:'join_requested', actorName:'applicant',workspaceName:'Alpha',requestMessage:'First request',requestPending:true,readAt:null}],unreadCount:1});
    expect(admin.notifications[0]).not.toHaveProperty('decision');
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
    for (const action of ['read', 'unread', 'archive', 'unarchive']) {
      expect((await call('deputy','notifications/'+other.id+'/'+action,'POST')).status).toBe(404);
    }

    const {requests} = await (await call('owner', 'join-requests')).json();
    const decide = (action: string) => call('owner', 'join-requests/'+requests[0].id+'/'+action, 'POST', {});
    expect((await decide('reject')).status).toBe(200);
    const rejection = (await inbox('owner')).notifications[0].decision;
    expect(rejection).toMatchObject({status:'rejected', actorName:'owner', isMe:true, at:expect.any(String)});
    expect((await decide('reject')).status).toBe(404);
    const declined = await inbox('applicant');
    expect(declined).toMatchObject({notifications:[{type:'join_rejected',actorName:'owner'}],unreadCount:1});
    expect(declined.notifications[0]).not.toHaveProperty('requestMessage');
    expect((await call('applicant','notifications/'+declined.notifications[0].id+'/read','POST')).status).toBe(200);
    expect((await submit('Second request')).status).toBe(200);
    const resubmitted = await inbox('owner');
    expect(resubmitted.unreadCount).toBe(1);
    expect(resubmitted.notifications[0]).not.toHaveProperty('decision');
    expect(resubmitted.notifications[0].requestMessage).toBe('Second request');
    expect(resubmitted.notifications[1]).not.toHaveProperty('requestMessage');
    expect(resubmitted.notifications[1]).not.toHaveProperty('requestPending');
    expect((await decide('approve')).status).toBe(200);
    const resolved = (await inbox('owner')).notifications;
    expect(resolved[0].requestPending).toBe(false);
    expect(resolved[0].decision).toMatchObject({status:'approved',actorName:'owner',isMe:true});
    expect(resolved[1].decision).toEqual(rejection);
    expect((await inbox('applicant')).notifications.map((n: {type:string}) => n.type)).toEqual(['join_approved','join_rejected']);
    expect((await inbox('deputy')).notifications).toEqual([]);
    expect((await (await submit()).json()).status).toBe('approved');
  });
  it('archives, restores and toggles read state independently for each recipient and workspace', async () => {
    await db.query(`INSERT INTO workspaces(id,slug,name) VALUES('d','delta','Delta');
      INSERT INTO workspace_notifications(id,workspace_id,recipient_id,actor_id,type)
      VALUES ('to-archive','d','owner','visitor','join_rejected'),('active','d','owner','visitor','join_approved')`);
    const archived = () => inbox('owner','delta',true);
    const active = () => inbox('owner','delta');
    const update = (action: string, user = 'owner', workspace = 'delta') =>
      call(user,'notifications/to-archive/'+action,'POST',undefined,workspace);
    expect(await archived()).toEqual({notifications:[],unreadCount:2});
    for (const action of ['read','unread','archive','unarchive']) {
      expect((await update(action,'visitor')).status).toBe(404);
      expect((await update(action,'owner','alpha')).status).toBe(404);
      expect((await update(action,'missing')).status).toBe(401);
    }
    expect((await update('archive')).status).toBe(200);
    const first = await archived();
    expect(first).toMatchObject({notifications:[{id:'to-archive',archivedAt:expect.any(String),readAt:null}],unreadCount:1});
    expect((await active()).notifications.map((n: {id: string}) => n.id)).toEqual(['active']);
    expect((await update('archive')).status).toBe(200);
    expect(await archived()).toEqual(first);
    expect((await call('owner','notifications/read-all','POST',undefined,'delta')).status).toBe(200);
    expect(await archived()).toEqual({...first,unreadCount:0});
    expect((await update('read')).status).toBe(200);
    expect((await archived()).notifications[0].readAt).toEqual(expect.any(String));
    expect((await update('unarchive')).status).toBe(200);
    expect(await archived()).toEqual({notifications:[],unreadCount:0});
    expect((await update('unread')).status).toBe(200);
    const restored = await active();
    expect(restored.unreadCount).toBe(1);
    expect(restored.notifications[0]).toMatchObject({id:'to-archive',archivedAt:null,readAt:null});
    expect((await update('unarchive')).status).toBe(200);
    expect((await update('unread')).status).toBe(200);
    expect(await active()).toEqual(restored);
  });
  it('delivers new discussion mentions and replies once and enforces inherited read access again on every inbox operation', async () => {
    await db.query(`INSERT INTO workspaces(id,slug,name) VALUES('discussions','discussions','Discussions');
      INSERT INTO memberships VALUES ('discussions','owner','admin'), ('discussions','deputy','member'), ('discussions','visitor','viewer');
      INSERT INTO pages(id,workspace_id,metadata,visibility) VALUES ('private-parent','discussions','{}','private'),
        ('discussions-page','discussions','{"parentId":"private-parent","title":"Notes"}','inherit');
      INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES ('private-parent','owner','full','owner'),('private-parent','deputy','view','owner');`);
    const mentioned = (id: string) => ({type:'person', id, start:0, label:'@pair'});
    const thread = {type:'database-comment',id:'thread',data:{text:'@pair',authorId:'owner',mentions:[mentioned('deputy'),mentioned('owner'),mentioned('visitor')]}};
    const reply = {type:'database-comment',id:'reply',parentId:'thread',data:{text:'Voilà',authorId:'deputy'}};
    async function save(blocks: unknown[], version: string) {
      return saveProjection(db,'discussions-page',JSON.stringify({blocks}),{version,lineage:null,sequence:null});
    }
    expect(await save([thread],'0')).toBe('1');
    expect(await save([thread,reply],'1')).toBe('2');
    expect(await save([thread,reply],'1')).toBe('2');
    expect((await inbox('owner','discussions')).notifications).toMatchObject([{type:'comment_reply',pageId:'discussions-page'}]);
    const recipient = await inbox('deputy','discussions');
    expect(recipient).toMatchObject({unreadCount:1,notifications:[{type:'comment_mention',pageTitle:'Notes'}]});
    expect(await inbox('visitor','discussions')).toEqual({unreadCount:0,notifications:[]});
    await db.query("DELETE FROM page_shares WHERE page_id='private-parent' AND user_id='deputy'");
    expect(await inbox('deputy','discussions')).toEqual({unreadCount:0,notifications:[]});
    expect((await call('deputy','notifications/'+recipient.notifications[0].id+'/read','POST',undefined,'discussions')).status).toBe(404);
  });
});
