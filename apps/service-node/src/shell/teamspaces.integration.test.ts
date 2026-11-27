import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShellApp } from './app.ts';

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
    expect(teamspace).toMatchObject({ memberCount:1, joined:true, canManage:true, owners:[{userId:"member"}], id: expect.any(String), name: name.trim(), workspaceId: 'w', createdAt: expect.any(String) });
    return teamspace.id as string;
  }
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    const sql = await readFile(new URL('../../../service/schema.sql', import.meta.url), 'utf8');
    await db.query(sql);
    await db.query(sql); // Bootstrap reapplies the canonical migrations on startup.
    const versions = await db.query('SELECT version FROM schema_migrations WHERE version IN (6,7,8) ORDER BY version');
    expect(versions.rows).toEqual([{ version: 6 }, { version: 7 }, { version: 8 }]);
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
    expect(await added.find(r => r.status === 201)!.json()).toMatchObject({member:{userId:'reader',email:'reader@test.invalid',role:'member'}});
    await call(path,'POST',{userId:'admin'});
    const listed = await call(path);
    expect((await listed.json()).members.map((m: {userId:string}) => m.userId)).toEqual(['admin','member','reader']);
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

  it('searches persisted text under current page permissions before returning excerpts', async () => {
    await db.query(`INSERT INTO pages(id,workspace_id,metadata,content,visibility) VALUES
      ('g1','w','{"title":"Recette"}','{"blocks":[{"data":{"text":"Le budget approuvé est de trente euros pour l’albatros"}}]}','workspace'),
      ('g2','w','{"title":"Finances privées"}','{"blocks":[{"data":{"text":"Budget confidentiel"}}]}','private'),
      ('g3','z','{"title":"Budget autre équipe"}','{}','workspace')`);
    const lookup = () => app.request('/api/workspaces/demo/search', {
      method:'POST', headers:{Authorization:'Bearer reader'}, body:JSON.stringify({query:'Quel est le budget ?'}) });
    const list = async () => { const response = await lookup(); expect(response.status).toBe(200); return (await response.json()).sources; };
    expect(await list()).toEqual([{id:'g1',title:'Recette',excerpt:expect.stringContaining('trente euros')}]);
    const preview = (id: string) => app.request('/api/workspaces/demo/pages/'+id+'?preview=1', {headers:{Authorization:'Bearer reader'}});
    expect(await (await preview('g1')).json()).toEqual({excerpt:'Le budget approuvé est de trente euros pour l’albatros'});
    expect((await preview('g2')).status).toBe(404);
    expect((await preview('g3')).status).toBe(404);
    const partial = await app.request('/api/workspaces/demo/search', {
      method:'POST', headers:{Authorization:'Bearer reader'}, body:JSON.stringify({query:'budg',mode:'palette'}) });
    expect((await partial.json()).sources.map((s: {id:string}) => s.id)).toEqual(['g1']);
    for (const query of ['albatros','l’albatros', "l'albatros"]) {
      const bird = await app.request('/api/workspaces/demo/search', {
        method:'POST', headers:{Authorization:'Bearer reader'}, body:JSON.stringify({query,mode:'palette'}) });
      expect((await bird.json()).sources.map((s:{id:string}) => s.id)).toEqual(['g1']);
    }
    await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('g2','reader','view','admin')");
    expect((await list()).map((s: {id:string}) => s.id).sort()).toEqual(['g1','g2']);
    await db.query("DELETE FROM page_shares WHERE page_id='g2'; UPDATE pages SET trashed=true WHERE id='g1'");
    expect((await preview('g1')).status).toBe(404);
    expect(await list()).toEqual([]);
  });

  it('searches rich text saved as segments, the shape every editor block really has', async () => {
    // Blok saves rich text as segments, never as a bare string: types/rich-text.d.ts.
    // A page whose text is a segment array must be as findable as one holding a plain string.
    await db.query(`INSERT INTO pages(id,workspace_id,metadata,content,visibility) VALUES
      ('s1','w','{"title":"Segments"}','{"blocks":[{"data":{"text":[{"text":"Le héron cendré niche près de l’étang"}]}}]}','workspace'),
      ('s2','w','{"title":"Marques"}','{"blocks":[{"data":{"text":[{"text":"Le héron "},{"text":"blanc","marks":["bold"]},{"text":" pêche au matin"}]}}]}','workspace')`);
    const find = async (query: string) => {
      const response = await app.request('/api/workspaces/demo/search', {
        method:'POST', headers:{Authorization:'Bearer reader'}, body:JSON.stringify({ query, mode:'palette' }) });
      expect(response.status).toBe(200);
      return ((await response.json()).sources as {id:string}[]).map(source => source.id).sort();
    };

    expect(await find('héron')).toEqual(['s1','s2']);
    // A word split across marks still belongs to the page that holds it.
    expect(await find('blanc')).toEqual(['s2']);
    expect(await find('étang')).toEqual(['s1']);
  });

  it('cites the block a match came from, and still finds a page that has none', async () => {
    await db.query(`INSERT INTO pages(id,workspace_id,metadata,content,visibility) VALUES
      ('c1','w','{"title":"Chantier"}','{"blocks":[
        {"id":"b-intro","data":{"text":[{"text":"Introduction sans rapport"}]}},
        {"id":"b-cible","data":{"text":[{"text":"La marmotte dort tout l’hiver"}]}}]}','workspace'),
      ('c2','w','{"title":"Page sans blocs"}','{"blocks":[]}','workspace'),
      ('c3','w','{"title":"Bloc anonyme"}','{"blocks":[{"data":{"text":[{"text":"Une marmotte anonyme"}]}}]}','workspace')`);
    const find = async (query: string) => {
      const response = await app.request('/api/workspaces/demo/search', {
        method:'POST', headers:{Authorization:'Bearer reader'}, body:JSON.stringify({ query, mode:'palette' }) });
      expect(response.status).toBe(200);
      return (await response.json()).sources as { id: string; blockId?: string }[];
    };

    // The citation points at the block holding the words, not at the first block of the page.
    expect(await find('marmotte hiver')).toContainEqual(expect.objectContaining({ id:'c1', blockId:'b-cible' }));
    // A page whose title alone matches stays findable even with no block to cite.
    expect((await find('Page sans blocs')).map(source => source.id)).toContain('c2');
    // A block saved without an id still makes its page findable; there is simply nothing to cite.
    const anonymous = (await find('anonyme')).find(source => source.id === 'c3');
    expect(anonymous).toBeDefined();
    expect(anonymous?.blockId).toBeUndefined();
  });

  it('persists metadata and enforces team ownership and the workspace creation policy', async () => {
    const id = await create('Catalogue');
    const path = '/' + id;
    expect((await call(path, 'PATCH', { icon:'🧑‍💻', description:'Documents produit' })).status).toBe(200);
    let directory = await (await call()).json();
    expect(directory.teamspaces.find((t: {id:string}) => t.id===id)).toMatchObject({
      icon:'🧑‍💻', description:'Documents produit', updatedAt:expect.any(String), owners:[{userId:'member'}],
    });
    for (const icon of ['https://example.test/x','data:image/svg+xml;base64,AAAA','not an icon', '📅📅']) {
      expect((await call(path,'PATCH',{icon})).status).toBe(400);
    }
    const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kxi0AAAAASUVORK5CYII=', 'base64');
    expect((await call(path,'PATCH',{icon:'data:image/png;base64,' + tiny.toString('base64')})).status).toBe(200);
    tiny.writeUInt32BE(500_000, 16);
    expect((await call(path,'PATCH',{icon:'data:image/png;base64,' + tiny.toString('base64')})).status).toBe(400);
    expect((await call(path,'PATCH',{icon:'icon:house:blue'})).status).toBe(200);
    expect((await call(path+'/members/member','DELETE')).status).toBe(409);
    expect((await call(path+'/members','POST',{userId:'reader',role:'owner'})).status).toBe(400);
    expect((await call(path+'/members','POST',{userId:'admin',role:'owner'})).status).toBe(201);
    expect((await call(path+'/members/member','PATCH',{role:'member'})).status).toBe(200);
    expect((await call(path,'PATCH',{description:'no permission'})).status).toBe(403);
    expect((await call(path+'/members/member','PATCH',{role:'owner'},'admin')).status).toBe(200);
    expect((await call('/settings','PATCH',{restrictCreation:true})).status).toBe(403);
    expect((await call('/settings','PATCH',{restrictCreation:true},'admin')).status).toBe(200);
    directory = await (await call()).json();
    expect(directory.canCreate).toBe(false);
    expect(directory.settings.restrictCreation).toBe(true);
    expect((await call('','POST',{name:'Refusé'})).status).toBe(403);
    expect((await call('','POST',{name:'Autorisé'},'admin')).status).toBe(201);
    expect((await call('/settings','PATCH',{restrictCreation:false},'admin')).status).toBe(200);
  });

  it('enrolls existing and future workspace members without granting access to a page', async () => {
    const id = await create('All hands');
    const path = '/' + id;
    expect((await call('/settings','PATCH',{defaultTeamspaceIds:[id,'other-team']},'admin')).status).toBe(404);
    expect((await call('/settings','PATCH',{defaultTeamspaceIds:[id]},'admin')).status).toBe(200);
    expect((await call(path+'/members/reader','DELETE')).status).toBe(409);
    const getTeam = async () => (await (await call()).json()).teamspaces.find((row: {id:string}) => row.id===id);
    expect(await getTeam()).toMatchObject({isDefault:true,memberCount:3,owners:[{userId:'member'}]});
    await db.query("INSERT INTO users(id,email) VALUES('newbie','newbie@test'); INSERT INTO memberships VALUES('w','newbie','viewer')");
    expect(await getTeam()).toMatchObject({memberCount:4});
    expect((await db.query("SELECT 1 FROM page_shares WHERE user_id='newbie'")).rowCount).toBe(0);
    expect((await call('/settings','PATCH',{defaultTeamspaceIds:[]},'admin')).status).toBe(200);
    expect(await getTeam()).toMatchObject({isDefault:false,memberCount:4});
    await db.query("DELETE FROM memberships WHERE user_id='newbie'; INSERT INTO memberships VALUES('w','newbie','member')");
    expect(await getTeam()).toMatchObject({memberCount:3});
  });

  it('serializes a concurrent admission and default-team change', async () => {
    const id = await create('Operations');
    await db.query("INSERT INTO users(id,email) VALUES('concurrent-member','concurrent@test')");
    const admission = await db.connect();
    try {
      await admission.query('BEGIN');
      await admission.query("INSERT INTO memberships VALUES('w','concurrent-member','viewer')");
      const change = call('/settings','PATCH',{defaultTeamspaceIds:[id]},'admin');
      await admission.query('COMMIT');
      expect((await change).status).toBe(200);
      expect((await db.query("SELECT role FROM teamspace_members WHERE workspace_id='w' AND teamspace_id=$1 AND user_id='concurrent-member'",[id])).rows)
        .toEqual([{role:'member'}]);
    } finally {
      await admission.query('ROLLBACK');
      admission.release();
    }
  });

  it('keeps historical teams editable without guessing who created them', async () => {
    await db.query("INSERT INTO teamspaces(id,workspace_id,name) VALUES('legacy','w','Legacy')");
    const directory = await (await call()).json();
    expect(directory.teamspaces.find((t: {id:string}) => t.id==='legacy')).toMatchObject({owners:[], canManage:true, description:'', isDefault:false});
    expect((await call('/legacy','PATCH',{name:'Renamed'})).status).toBe(200);
    expect((await call('/legacy','PATCH',{description:'Viewer'},'reader')).status).toBe(403);
  });

  it('enforces both workspace relations even on direct SQL writes', async () => {
    const id = await create('Operations');
    await expect(db.query('INSERT INTO teamspace_members VALUES($1,$2,$3)', ['z',id,'outsider'])).rejects.toMatchObject({ code:'23503' });
    await expect(db.query('INSERT INTO teamspace_members VALUES($1,$2,$3)', ['w',id,'outsider'])).rejects.toMatchObject({ code:'23503' });
    await db.query("INSERT INTO users(id,email) VALUES('departed','departed@test'); INSERT INTO memberships VALUES('w','departed','member')");
    await call('/'+id+'/members','POST',{userId:'departed'});
    await db.query("DELETE FROM memberships WHERE workspace_id='w' AND user_id='departed'; DELETE FROM users WHERE id='departed'");
    expect((await (await call('/'+id+'/members')).json()).members.map((m: {userId:string}) => m.userId)).toEqual(['member']);
  });
});
