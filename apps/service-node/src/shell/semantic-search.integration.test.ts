import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHostedAi } from './hosted-ai.ts';
import { ensureVectorIndex } from './vector-index.ts';
import { createEmbeddings, indexNextPage, PROJECTION, semanticHits } from './embeddings.ts';
import { createWorkspaceSearch } from './workspace-search.ts';

const url = process.env.VECTOR_TEST_DATABASE_URL;
const schema = 'test_semantic_' + randomUUID().replaceAll('-', '');
const db = new pg.Pool({ connectionString: url, options: '-csearch_path=' + schema + ',public -c jit=off' });
const master = Buffer.alloc(32, 7);
const requested: string[] = [];
const upstream = vi.fn(async (endpoint: string | URL | Request, init?: RequestInit) => {
  expect(String(endpoint)).toBe('https://api.openai.com/v1/embeddings');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer workspace-test-key');
  const body = JSON.parse(String(init?.body));
  expect(body.model).toBe('text-embedding-3-small');
  requested.push(...body.input);
  // Replay measured cosine scores against a unit document vector, without contacting OpenAI.
  const scores = new Map([
    ['Quel animal capture du poisson ?', 0.435],
    ['Combien de lunes a Saturne ?', 0.149],
    ['Comment renouveler un passeport ?', 0.396],
  ]);
  return Response.json({
    data: body.input
      .map((input: string, index: number) => {
        const cosine = scores.get(input) ?? 1;
        return {index, embedding: [cosine, Math.sqrt(1 - cosine ** 2), ...Array(1534).fill(0)]};
      })
      .reverse(),
  });
});
const embed = createEmbeddings(master, upstream, db);
const app = new Hono();
app.route(
  '/api/:slug/ai',
  createHostedAi(db, upstream, async () => master, true),
);
app.route('/api/:slug/search', createWorkspaceSearch(db, embed));
const post = (path: string, body: object, user = 'reader', method = 'POST') =>
  app.request('/api/demo/' + path, {
    method,
    headers: { authorization: 'Bearer ' + user, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const doc = (id: string, text: string) => ({
  blocks: [{ id, type: 'paragraph', data: { text: [{ text }] } }],
});
const run = () => indexNextPage(db, embed, new AbortController().signal);
beforeAll(async () => {
  if (!url) return;
  await db.query('CREATE SCHEMA ' + schema);
  await db.query(await readFile(new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
  expect(await ensureVectorIndex(db, PROJECTION)).toBe(true);
  await db.query(
    "INSERT INTO workspaces(id,slug,name) VALUES('w','demo','Demo'); INSERT INTO users(id,email) VALUES('admin','a@test'),('reader','r@test'); INSERT INTO memberships VALUES('w','admin','admin'),('w','reader','viewer')",
  );
  for (const user of ['admin', 'reader'])
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [
      createHash('sha256').update(user).digest('hex'),
      user,
    ]);
});
afterAll(async () => {
  if (url) await db.query('DROP SCHEMA ' + schema + ' CASCADE');
  await db.end();
});

it.skipIf(!url)(
  'indexes with the shared key, finds a paraphrase and enforces access and freshness on every search',
  async () => {
    for (const [id, visibility] of [
      ['a-private', 'private'],
      ['z-public', 'workspace'],
    ]) {
      await db.query(
        "INSERT INTO pages(id,workspace_id,metadata,visibility,content) VALUES($1,'w','{}',$2,$3)",
        [id, visibility, doc('citation', 'Le héron pêche.')],
      );
    }
    await post('ai/credentials', { scope: 'personal', apiKey: 'personal-test-key' }, 'reader', 'PUT');
    expect(await run()).toBe(false);
    await post('ai/credentials', { scope: 'workspace', apiKey: 'workspace-test-key' }, 'admin', 'PUT');
    expect(await run()).toBe(false);
    expect((await post('ai/embeddings', { enabled: true }, 'reader', 'PUT')).status).toBe(403);
    expect((await post('ai/embeddings', { enabled: true }, 'admin', 'PUT')).status).toBe(200);
    expect(await run()).toBe(true);
    expect(await run()).toBe(true);
    expect(await run()).toBe(false);
    const query = { query: 'Quel animal capture du poisson ?' };
    expect((await (await post('search', query)).json()).sources).toEqual([
      { id: 'z-public', title: '', blockId: 'citation', excerpt: 'Le héron pêche.' },
    ]);
    const usage = async (token:string) => {
      const end = new Date().toISOString().slice(0,10);
      return (await app.request('/api/demo/ai/usage?end='+end+'&days=7',{headers:{authorization:'Bearer '+token}})).json();
    };
    expect(await usage('reader')).toMatchObject({rows:[{feature:'query',calls:1,measured:0}]});
    expect(await usage('admin')).toMatchObject({rows:[{feature:'index',calls:2,measured:0}]});
    expect((await (await post('search', { query: 'Combien de lunes a Saturne ?' })).json()).sources).toEqual([]);
    expect((await (await post('search', { query: 'Comment renouveler un passeport ?' })).json()).sources).toEqual([]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      upstream.mockResolvedValueOnce(new Response('limit', { status: 429 }));
      expect((await (await post('search', { query: 'héron' })).json()).sources[0].id).toBe('z-public');
      const logs = [...info.mock.calls, ...warn.mock.calls].flat().join('\n');
      expect(logs).toContain('embedding.query');
      expect(logs).toContain('429');
      expect(logs).not.toMatch(/workspace-test-key|héron|Quel animal/);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
    const count = requested.length;
    expect((await (await post('search', { ...query, mode: 'palette' })).json()).sources).toEqual([]);
    expect(requested).toHaveLength(count);
    await db.query("UPDATE pages SET content=$1 WHERE id='z-public'", [doc('new', 'La loutre nage.')]);
    expect((await (await post('search', query)).json()).sources).toEqual([]);
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const slow = indexNextPage(
      db,
      async (...args) => {
        entered();
        await gate;
        return embed(...args);
      },
      new AbortController().signal,
    );
    await started;
    expect(await run()).toBe(false);
    await db.query("UPDATE pages SET content=$1 WHERE id='z-public'", [doc('newer', 'La tortue avance.')]);
    expect(await run()).toBe(true);
    resume();
    await slow;
    expect((await (await post('search', query)).json()).sources[0].blockId).toBe('newer');
    await db.query("UPDATE pages SET visibility='private' WHERE id='z-public'");
    expect((await (await post('search', query)).json()).sources).toEqual([]);
    await db.query("UPDATE pages SET visibility='workspace' WHERE id='z-public'");
    // A global nearest-neighbour preselection would fill all ten places with private pages.
    const publicIds = Array.from({ length: 10 }, (_, i) => 'visible-' + i);
    await db.query(
      `INSERT INTO pages(id,workspace_id,metadata,visibility)
    SELECT 'hidden-'||i,'w','{}'::jsonb,'private' FROM generate_series(1,90) i UNION ALL
    SELECT id,'w','{}'::jsonb,'workspace' FROM unnest($1::text[]) id`,
      [publicIds],
    );
    await db.query(
      `INSERT INTO page_chunks(id,page_id,workspace_id,chunk_index,text,embedding,model,page_version)
    SELECT p.id,p.id,'w',0,'Example',CASE WHEN p.visibility='private' THEN $1::vector ELSE $2::vector END,
      (SELECT model FROM page_chunks LIMIT 1),0 FROM pages p WHERE id LIKE 'visible-%' OR id LIKE 'hidden-%'`,
      [JSON.stringify([1, ...Array(1535).fill(0)]), JSON.stringify([0.5, Math.sqrt(0.75), ...Array(1534).fill(0)])],
    );
    await db.query(
      "UPDATE page_embedding_jobs SET due_at=NULL WHERE page_id LIKE 'visible-%' OR page_id LIKE 'hidden-%'",
    );
    const client = await db.connect();
    try {
      const hits = await semanticHits(
        client,
        'w',
        publicIds,
        JSON.stringify([1, ...Array(1535).fill(0)]),
        10,
      );
      expect(hits.map((hit) => hit.id).sort()).toEqual([...publicIds].sort());
    } finally {
      client.release();
    }
    expect((await post('ai/embeddings', { enabled: false }, 'admin', 'PUT')).status).toBe(200);
    expect((await (await post('search', query)).json()).sources).toEqual([]);
  },
  // Indexes two pages, races a slow worker against a newer revision, then ranks 100 pages.
  // It runs in about eight seconds; the default five would fail it on its size, not its subject.
  20_000,
);

it.skipIf(!url)('keeps French paraphrases and abstains on unrelated questions using recorded cosine scores', async () => {
  // Only the three question-to-document cosines matter for exact search. Encode those measured
  // coordinates in unit vectors to replay the OpenAI sample without an API key.
  const workspace = 'relevance';
  const pages = [
    ['depart', 'Départ volontaire', 'À réception de la démission, les ressources humaines organisent la passation et la restitution du matériel.'],
    ['frais', 'Notes de frais', 'Les justificatifs des dépenses professionnelles sont déposés dans le portail comptable avant le vendredi.'],
    ['badge', 'Accès aux locaux', 'Un badge perdu est désactivé par l’accueil, qui délivre un laissez-passer temporaire.'],
  ] as const;
  const cases: [string, number[], string[]][] = [
    ['Que faire si un collègue quitte notre entreprise ?', [0.493, 0.233, 0.318], ['depart']],
    ['Comment se faire rembourser un repas professionnel ?', [0.321, 0.435, 0.293], ['frais']],
    ['J’ai égaré ma carte pour entrer au bureau, à qui m’adresser ?', [0.318, 0.342, 0.512], ['badge']],
    ['Quelle température faut-il pour cuire un gâteau au chocolat ?', [0.090, 0.099, 0.083], []],
    ['Combien de lunes a Saturne ?', [0.129, 0.149, 0.128], []],
    ['Quelle est la procédure pour renouveler un passeport ?', [0.348, 0.280, 0.396], []],
    // The topic matches, but the source omits the amount. The chat must decide sufficiency.
    ['Quel est le montant des indemnités après une démission ?', [0.486, 0.299, 0.240], ['depart']],
  ];
  const vector = (coords: number[]) =>
    JSON.stringify([...coords, Math.sqrt(1 - coords.reduce((sum, x) => sum + x * x, 0)), ...Array(1532).fill(0)]);
  const client = await db.connect();
  try {
    await client.query('INSERT INTO workspaces(id,slug,name) VALUES($1,$1,$1)', [workspace]);
    await client.query("INSERT INTO ai_credentials(scope,owner_id,encrypted_key,embeddings_enabled) VALUES('workspace',$1,$2,true)", [workspace, Buffer.from('fixture')]);
    for (const [axis, [id, title, excerpt]] of pages.entries()) {
      await client.query('INSERT INTO pages(id,workspace_id,metadata,content) VALUES($1,$2,$3,$4)', [id, workspace, {title}, doc(id, excerpt)]);
      await client.query(`INSERT INTO page_chunks(id,page_id,workspace_id,chunk_index,text,block_ids,embedding,model,page_version)
        SELECT id,id,workspace_id,0,$2,ARRAY[id],$3::vector,$4,version FROM pages WHERE id=$1`,
        [id, excerpt, vector(pages.map((_, i) => Number(i === axis))), PROJECTION]);
    }
    const ids = pages.map(([id]) => id);
    await client.query('UPDATE page_embedding_jobs SET due_at=NULL WHERE page_id=ANY($1::text[])', [ids]);
    for (const [question, scores, expected] of cases) {
      const hits = await semanticHits(client, workspace, ids, vector(scores), 5);
      expect(hits.map(hit => hit.blockId), question).toEqual(expected);
    }
  } finally {
    client.release();
  }
});
