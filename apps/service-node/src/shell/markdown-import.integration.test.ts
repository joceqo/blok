import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createShellApp} from './app.ts';

const databaseUrl = process.env.SHELL_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('Markdown page import', () => {
  const schema = 'markdown_' + randomUUID().replaceAll('-', '');
  const owner = new pg.Pool({connectionString:databaseUrl});
  const db = new pg.Pool({connectionString:databaseUrl, options:'-csearch_path=' + schema});
  const app = createShellApp(db, 'm'.repeat(32), new Set());
  const input = {source:'# 🚗 Feuille de route\n\n**En gras** et [un lien](https://example.org).\n\n- premier\n  - enfant', name:'roadmap.md', attempt:randomUUID()};
  const send = (actor:string, body=input) => app.request('/api/workspaces/demo/import/markdown', {
    method:'POST', headers:{Authorization:'Bearer '+actor}, body:JSON.stringify(body),
  });
  beforeAll(async () => {
    await owner.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(process.env.SHELL_TEST_SCHEMA_PATH ?? new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
    await db.query(`INSERT INTO users(id,email) VALUES ('m','m@test'),('v','v@test');
      INSERT INTO workspaces(id,slug,name) VALUES ('w','demo','Demo');
      INSERT INTO memberships VALUES ('w','m','member'),('w','v','viewer')`);
    for (const actor of ['m','v']) await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [createHash('sha256').update(actor).digest('hex'),actor]);
  });
  afterAll(async () => {
    await db.end();
    try { await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); } finally { await owner.end(); }
  });
  it('commits one private page with valid content for two concurrent retries', async () => {
    const responses = await Promise.all([send('m'),send('m')]);
    expect(responses.map(r=>r.status)).toEqual([200,200]);
    const ids = await Promise.all(responses.map(async r=>(await r.json()).id));
    expect(ids[0]).toBe(ids[1]);
    const saved = await db.query('SELECT metadata,content,visibility FROM pages WHERE workspace_id=$1',['w']);
    expect(saved.rowCount).toBe(1);
    const page = saved.rows[0];
    expect(page.metadata).toMatchObject({id:ids[0],title:'Feuille de route',icon:'🚗',parentId:null});
    expect(page.visibility).toBe('private');
    expect(page.content.blocks).toHaveLength(3);
    expect(page.content.blocks[0].data.text).toContain('https://example.org');
    expect(page.content.blocks[2].parent).toBe(page.content.blocks[1].id);
    expect((await db.query('SELECT user_id,level FROM page_shares WHERE page_id=$1',[ids[0]])).rows).toEqual([{user_id:'m',level:'full'}]);
  });
  it('imports CSV rows into one private database page and preserves quoted values', async () => {
    const csv = {...input, name:'Budget.csv', source:'Item,Amount\r\n"Coffee, beans",14'};
    const post = () => app.request('/api/workspaces/demo/import/csv', {
      method:'POST', headers:{Authorization:'Bearer m'}, body:JSON.stringify(csv),
    });
    const response = await post();
    expect(response.status).toBe(200);
    const {id} = await response.json();
    expect(await (await post()).json()).toEqual({id});
    const {rows:[page]} = await db.query('SELECT content,visibility FROM pages WHERE id=$1',[id]);
    expect(page.visibility).toBe('private');
    const [database,row] = page.content.blocks;
    expect(database).toMatchObject({type:'database', content:[row.id]});
    expect(row).toMatchObject({type:'database-row',parent:database.id,data:{title:'Coffee, beans'}});
    expect(Object.values(row.data.properties)).toContain(14);
  });
  it('rechecks private overrides and trash at export time', async () => {
    const headers = {Authorization:'Bearer m'};
    const pagePath = '/api/workspaces/demo/export/pages/child';
    await db.query(`INSERT INTO pages(id,workspace_id,metadata,content,visibility)
      VALUES('parent','w','{"id":"parent","parentId":null}','{"blocks":[]}','workspace'),
            ('child','w','{"id":"child","parentId":"parent"}','{"blocks":[]}','private')`);
    await db.query("INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES('child','m','full','m')");
    const index = await app.request('/api/workspaces/demo/export/index',{headers});
    expect((await index.json()).access.child.visibility).toBe('private');
    expect((await app.request(pagePath,{headers})).status).toBe(404);
    expect((await app.request(pagePath+'?private=1',{headers})).status).toBe(200);
    expect((await app.request(pagePath+'?private=1',{headers:{Authorization:'Bearer v'}})).status).toBe(404);
    await db.query("UPDATE pages SET trashed=true WHERE id='child'");
    expect((await app.request(pagePath+'?private=1',{headers})).status).toBe(404);
  });
  it('imports a Notion-shaped ZIP atomically, preserving its pages, database, links and image', async () => {
    const bytes = await readFile(new URL('../../../../test/fixtures/workspace-import/notion-md-csv.zip',import.meta.url));
    const path = '/api/workspaces/demo/import/zip?name=Migration.zip&attempt='+randomUUID();
    const post = (actor:string, data=bytes) => app.request(path,{method:'POST',
      headers:{Authorization:'Bearer '+actor,'Content-Type':'application/zip'},body:new Uint8Array(data)});
    expect((await post('v')).status).toBe(403);
    const before = Number((await db.query('SELECT count(*) AS n FROM pages')).rows[0].n);
    expect((await post('m',Buffer.from('bad zip'))).status).toBe(422);
    const response = await post('m');
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(await (await post('m')).json()).toEqual(result);
    const {rows} = await db.query('SELECT id,metadata,content,visibility FROM pages');
    expect(rows.length).toBe(before+4);
    const root = rows.find(row=>row.id===result.id);
    const team = rows.find(row=>row.metadata.title==='Equipe');
    const budget = rows.find(row=>row.metadata.parentId===team.id && row.metadata.title==='Budget');
    const coffee = rows.find(row=>row.metadata.parentId===budget.id && row.metadata.title==='Café');
    expect(root.visibility).toBe('private');
    expect(team.metadata.parentId).toBe(root.id);
    expect(team.content.blocks.some((b:{data:{url?:string}})=>b.data.url?.startsWith('data:image/png;base64,'))).toBe(true);
    expect(team.content.blocks[0].data.text).toContain('data-blok-page-id="'+budget.id+'"');
    expect(budget.content.blocks.find((b:{type:string})=>b.type==='database-row').data.pageId).toBe(coffee.id);
  });
  it('rejects viewer, expired session and unknown extension before creating a page', async () => {
    const before = await db.query('SELECT count(*) FROM pages');
    expect((await send('v')).status).toBe(403);
    expect((await send('expired')).status).toBe(401);
    expect((await send('m',{...input,name:'file.bin'})).status).toBe(400);
    expect((await db.query('SELECT count(*) FROM pages')).rows).toEqual(before.rows);
  });
});
