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
  it('rejects viewer, expired session and unknown extension before creating a page', async () => {
    const before = await db.query('SELECT count(*) FROM pages');
    expect((await send('v')).status).toBe(403);
    expect((await send('expired')).status).toBe(401);
    expect((await send('m',{...input,name:'file.bin'})).status).toBe(400);
    expect((await db.query('SELECT count(*) FROM pages')).rows).toEqual(before.rows);
  });
});
