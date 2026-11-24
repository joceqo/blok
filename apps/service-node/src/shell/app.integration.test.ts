import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShellApp } from './app.js';

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
