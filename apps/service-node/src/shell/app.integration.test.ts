import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequestCode, trustedClientIP } from './request-code.ts';
import { createShellAuth } from './auth.ts';
import { createShellApp } from './app.ts';

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

  describe('canonical login codes', () => {
    const email = 'new.account@example.test';
    const code = '002431';
    const verify = (email: string, code: string, client?: string) => app.request('/api/auth/verify-code', {
      method: 'POST', body: JSON.stringify({ email, code, client }),
    });
    const issue = (email: string) => db.query(`INSERT INTO login_codes(email,digest,expires_at)
      VALUES($1,$2,now()+interval '5 minutes') ON CONFLICT(email) DO UPDATE SET
      digest=excluded.digest,expires_at=excluded.expires_at,attempts=0`,
      [email, createHash('sha256').update(email + ':' + code + ':' + secret).digest('hex')]);

    it('enforces current admission and consumes an invitation and challenge exactly once', async () => {
      await db.query("UPDATE instance_settings SET signup_policy='invite'");
      await issue(email);
      expect((await verify(email, code)).status).toBe(401);
      await db.query(`INSERT INTO invites(id,workspace_id,email,role,expires_at)
        VALUES('auth-invite','w',$1,'viewer',now()+interval '1 hour')`, [email]);
      const results = await Promise.all([verify(email.toUpperCase(), code, 'desktop'), verify(email, code, 'desktop')]);
      expect(results.map(r => r.status).sort()).toEqual([200,401]);
      const success = results.find(r => r.status === 200)!;
      expect(success.headers.get('Set-Cookie')).toBeNull();
      const signed = await success.json();
      expect(signed.workspaces).toEqual([{ id:'w', slug:'demo', name:'Demo', role:'viewer' }]);
      expect((await app.request('/api/session', { headers: { Authorization:'Bearer ' + signed.token } })).status).toBe(200);
      expect((await db.query("SELECT status FROM invites WHERE id='auth-invite'")).rows[0].status).toBe('accepted');
    });

    it('invalidates the session before confirming the live access check, including on retry', async () => {
      const token = randomUUID();
      const digest = createHash('sha256').update(token).digest('hex');
      await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,'m',now()+interval '1 hour')", [digest]);
      let rechecks = 0;
      const auth = createShellAuth(db, secret, async () => {
        expect((await db.query('SELECT id FROM sessions WHERE id=$1', [digest])).rowCount).toBe(0);
        rechecks++;
      });
      for (let i=0; i<2; i++) {
        const response = await auth.request('/logout', {method:'POST', headers:{Cookie:'blok_session=' + token}});
        expect(response.status).toBe(200);
        expect(response.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
      }
      expect(rechecks).toBe(2);
      expect((await app.request('/api/session', { headers: { Authorization:'Bearer ' + token } })).status).toBe(401);
    });

    it('charges the real network peer, enforces mail cooldown and removes undelivered challenges', async () => {
      const ip = trustedClientIP('172.30.91.3/32');
      expect(ip('::ffff:172.30.91.3','198.51.100.42, 192.0.2.1')).toBe('192.0.2.1');
      expect(ip('192.0.2.1','198.51.100.42')).toBe('192.0.2.1');
      const sent: string[] = [];
      const router = createRequestCode(db, secret, {
        normalize: async email => email.trim().toLowerCase(),
        deliver: async (email, code) => {
          if (email === 'unavailable@sample.test') throw new Error('Offline mail');
          sent.push(code);
        },
      },'172.30.91.3/32');
      const submit = (email: string) => router.request('/request-code', {
        method:'POST',body:JSON.stringify({email}),headers:{'X-Forwarded-For':'198.51.100.42'},
      }, { incoming:{ socket:{ remoteAddress:'::ffff:172.30.91.3' } } });
      await db.query("UPDATE instance_settings SET signup_policy='invite'");
      expect((await submit('unknown@sample.test')).status).toBe(200);
      expect(sent).toEqual([]);
      await db.query("UPDATE instance_settings SET signup_policy='open'");
      const email = 'request.code@sample.test';
      expect((await submit(email)).status).toBe(200);
      expect((await submit(email)).status).toBe(429);
      expect(sent).toHaveLength(1);
      expect((await verify(email, sent[0]!)).status).toBe(200);
      expect((await submit('unavailable@sample.test')).status).toBe(503);
      expect((await db.query("SELECT FROM login_codes WHERE email='unavailable@sample.test'")).rowCount).toBe(0);
      expect((await db.query("SELECT count FROM email_rate_limits WHERE key='login-ip:198.51.100.42'")).rows[0].count).toBe(4);
    });

    it('bounds guesses, rechecks exact signup domains and issues an HttpOnly browser cookie', async () => {
      const allowed = 'browser@sample.test';
      const refused = 'browser@other.sample.test';
      await db.query("UPDATE instance_settings SET signup_policy='domain',signup_domains=ARRAY['sample.test']");
      await issue(refused);
      expect((await verify(refused, code)).status).toBe(401);
      await issue(allowed);
      for (let i=0; i<5; i++) expect((await verify(allowed, 'abcdef')).status).toBe(401);
      expect((await verify(allowed, code)).status).toBe(401);
      await issue(allowed);
      const result = await verify(allowed, code);
      expect(result.status).toBe(200);
      expect(result.headers.get('Set-Cookie')).toMatch(/blok_session=.*HttpOnly/);
      expect(await result.json()).not.toHaveProperty('token');
    });
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

  describe('workspace index writes', () => {
    const page = (id: string, parentId: string | null = null) => ({ id, title: id, parentId });
    async function freshWorkspace() {
      const id = randomUUID();
      await db.query("INSERT INTO workspaces(id,slug,name) VALUES($1,$1,'index test')", [id]);
      await db.query("INSERT INTO memberships VALUES($1,'m','member')", [id]);
      const observed: string[] = [];
      const api = createShellApp(db, secret, new Set(), async workspaceId => {
        // A separate connection observes the committed revision before the HTTP 200.
        const { rows } = await db.query('SELECT revision FROM workspaces WHERE id=$1', [workspaceId]);
        observed.push(rows[0].revision);
      });
      const put = (revision: number, pages: object[], trash: object[] = []) =>
        api.request('/api/workspaces/' + id + '/index', {
          method:'PUT', headers, body:JSON.stringify({revision, pages, trash}),
        });
      return { id, observed, put };
    }

    it('atomically creates a private root, grants its author full, and moves, trashes and deletes a child', async () => {
      const { id, observed, put } = await freshWorkspace();
      const root = page(id+'-private');
      const child = page(id+'-child', root.id);
      const open = page(id+'-public');
      const created = await put(0, [{...root, initialVisibility:'private'}, child, open]);
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({revision:1});
      const { rows } = await db.query(`SELECT p.visibility, sh.level, p.metadata ? 'initialVisibility' AS intent
        FROM pages p JOIN page_shares sh ON sh.page_id=p.id AND sh.user_id='m' WHERE p.id=$1`, [root.id]);
      expect(rows).toEqual([{visibility:'private',level:'full',intent:false}]);
      const moved = {...child, parentId:open.id};
      expect((await put(1, [open,root,moved])).status).toBe(200);
      expect((await put(2, [root,open], [moved])).status).toBe(200);
      const stored = (await db.query('SELECT metadata,trashed FROM pages WHERE id=$1',[child.id])).rows[0];
      expect(stored).toMatchObject({metadata:{parentId:open.id},trashed:true});
      expect((await put(3,[root,open])).status).toBe(200);
      expect((await db.query('SELECT deleted FROM pages WHERE id=$1',[child.id])).rows[0].deleted).toBe(true);
      expect((await put(4,[root,open,child])).status).toBe(409);
      expect(observed).toEqual(['1','2','3','4']);
    });

    it('locks concurrent writers; exactly one receives the next revision', async () => {
      const { id, put, observed } = await freshWorkspace();
      const results = await Promise.all([put(0,[page(id+'-a')]),put(0,[page(id+'-b')])]);
      expect(results.map(r => r.status).sort()).toEqual([200,409]);
      expect((await db.query('SELECT id FROM pages WHERE workspace_id=$1',[id])).rowCount).toBe(1);
      expect(observed).toEqual(['1']);
    });

    it('reports the committed revision if the live access refresh fails', async () => {
      const { id, put } = await freshWorkspace();
      const offline = createShellApp(db, secret, new Set(), async () => { throw new Error('offline'); });
      const path = '/api/workspaces/' + id + '/index';
      const entry = page(id + '-page');
      const response = await offline.request(path, {
        method: 'PUT', headers, body: JSON.stringify({ revision: 0, pages: [entry], trash: [] }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Index saved, live access refresh failed', revision: 1 });
      const reload = await offline.request(path, { headers });
      expect(await reload.json()).toMatchObject({ revision: 1, pages: [{ id: entry.id }] });
      expect((await put(0, [entry])).status).toBe(409);
    });

    it('keeps hidden records and read-only fields, rejects a guessed hidden ID and rolls back a global ID collision', async () => {
      const { id, put } = await freshWorkspace();
      const hidden = page(id+'-hidden');
      const child = page(id+'-child',hidden.id);
      const readOnly = page(id+'-read');
      for (const entry of [hidden,child,readOnly]) {
        await db.query("INSERT INTO pages(id,workspace_id,metadata,visibility) VALUES($1,$2,$3,'private')",[entry.id,id,entry]);
      }
      await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,'m','edit','m'),($2,'m','view','m')",[child.id,readOnly.id]);
      expect((await put(0,[hidden])).status).toBe(403);
      const detached = {...child,parentId:null,title:'renamed'};
      expect((await put(0,[detached,{...readOnly,title:'ignored'}])).status).toBe(200);
      const read = (id: string) => db.query('SELECT metadata, deleted FROM pages WHERE id=$1',[id]).then(r => r.rows[0]);
      expect(await read(child.id)).toMatchObject({metadata:{parentId:hidden.id,title:'renamed'}});
      expect(await read(readOnly.id)).toMatchObject({metadata:{title:readOnly.title}});
      expect(await read(hidden.id)).toMatchObject({deleted:false});
      expect((await put(1,[page('public')])).status).toBe(409);
      expect(await read(child.id)).toMatchObject({deleted:false});
      await db.query("UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id='m'",[id]);
      expect((await put(1,[])).status).toBe(403);
    });
  });
});
