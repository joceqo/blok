import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sealAiKey } from './ai-crypto.ts';
import { createEmbeddings, indexNextPage, PROJECTION } from './embeddings.ts';
import { ensureVectorIndex } from './vector-index.ts';

/**
 * The golden record of what Blok sends to the embedding model.
 *
 * Retrieval quality is decided here and nowhere else: the chunk boundaries, and the context that
 * tells a passage where it comes from. Both are invisible from the outside — a worse index returns
 * worse answers without a single failure. So the exact strings are written down, and any change to
 * extraction, chunking or context has to change this file on purpose.
 *
 * Read the expected array as a reviewer: each line is one vector in the index. Ask whether someone
 * asking a question in their own words would land on it.
 */
const url = process.env.VECTOR_TEST_DATABASE_URL;
const schema = 'test_golden_' + randomUUID().replaceAll('-', '');
const db = new pg.Pool({ connectionString: url, options: '-csearch_path=' + schema + ',public -c jit=off' });
const master = Buffer.alloc(32, 7);
const sent: string[] = [];
const upstream = vi.fn(async (_endpoint: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  sent.push(...body.input);

  return Response.json({
    data: body.input.map((_: string, index: number) => ({
      index,
      embedding: [1, ...Array(1535).fill(0)],
    })),
  });
});

beforeAll(async () => {
  if (!url) return;
  await db.query('CREATE SCHEMA ' + schema);
  await db.query(await readFile(new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
  expect(await ensureVectorIndex(db, PROJECTION)).toBe(true);
  await db.query("INSERT INTO workspaces(id,slug,name) VALUES('w','demo','Demo')");
  await db.query("INSERT INTO users(id,email) VALUES('admin','a@test')");
  await db.query("INSERT INTO memberships VALUES('w','admin','admin')");
  await db.query(
    `INSERT INTO ai_credentials(owner_id,scope,encrypted_key,embeddings_enabled)
     VALUES('w','workspace',$1,true)`,
    [sealAiKey(master, 'workspace:w', 'workspace-test-key')],
  );
});
afterAll(async () => {
  if (url) await db.query('DROP SCHEMA ' + schema + ' CASCADE');
  await db.end();
});

it.skipIf(!url)('embeds a page the way a reader would read it', async () => {
  await db.query(
    "INSERT INTO pages(id,workspace_id,metadata) VALUES('rh','w',$1)",
    [JSON.stringify({ title: 'Ressources humaines' })],
  );
  await db.query("INSERT INTO pages(id,workspace_id,metadata,content) VALUES('depart','w',$1,$2)", [
    JSON.stringify({ title: 'Procédure de départ', parentId: 'rh' }),
    JSON.stringify({
      blocks: [
        { id: 'h1', type: 'header', data: { text: [{ text: 'Les démarches' }] } },
        { id: 'p1', type: 'paragraph', data: { text: [{ text: 'Prévenir le service le jour même.' }] } },
        { id: 'h2', type: 'header', data: { text: [{ text: 'Le matériel' }] } },
        { id: 'p2', type: 'paragraph', data: { text: [{ text: 'Rendre le portable et le badge.' }] } },
        {
          id: 'db',
          type: 'database',
          data: {
            title: 'Pièces à rendre',
            schema: [
              { id: 'c1', name: 'Pièce', type: 'title', position: 'a0' },
              {
                id: 'c2',
                name: 'État',
                type: 'status',
                position: 'a1',
                config: { options: [{ id: 'o1', label: 'En attente', position: 'a0' }] },
              },
              { id: 'c3', name: 'Où', type: 'text', position: 'a2' },
            ],
          },
        },
        {
          id: 'r1',
          type: 'database-row',
          parent: 'db',
          data: { title: 'Badge', properties: { c1: 'Badge', c2: 'o1', c3: [{ text: 'À rendre à l\'accueil' }] } },
        },
      ],
    }),
  ]);
  const embed = createEmbeddings(master, upstream);
  // Drain the queue: both pages, in the order the worker takes them.
  while (await indexNextPage(db, embed, new AbortController().signal));

  expect(sent).toEqual([
    // A page with no body of its own still earns a vector: its name is what people search for.
    'Ressources humaines',
    // Every chunk is told the trail of pages above it, then the section it sits in. Without that
    // line, "Prévenir le service le jour même." answers no question asked in someone else's words.
    'Ressources humaines › Procédure de départ — Les démarches\nLes démarches\nPrévenir le service le jour même.',
    // The database's own vocabulary — its name, its column names, the labels it offers — is read
    // once, here, on the database block. A row never repeats it.
    'Ressources humaines › Procédure de départ — Le matériel\nLe matériel\nRendre le portable et le badge.\nPièces à rendre Pièce État Où En attente',
    // The row is named by the database that holds it, not by the heading above the database.
    // Every value is named by its column, and the choice is named by its label — the id it really
    // stores ("o1") is a word no one can read. This is what makes "quelles pièces sont en attente ?"
    // answerable at all: without "État : En attente" on the row, the state belongs to no task.
    'Ressources humaines › Procédure de départ — Pièces à rendre\n'
      + 'Badge Pièce : Badge · État : En attente · Où : À rendre à l\'accueil',
  ]);
});

/**
 * A page link stores a page id and nothing else, so a page that cites "Procédure de départ" held
 * no trace of that phrase. The cited page's title belongs in the index — but only when everyone
 * who can read the citing page can also read the cited one.
 *
 * Every reader of a workspace is a member of it (readWorkspaceScope: "Workspace membership
 * required"), and a page whose visibility resolves to `workspace` is readable by every member. A
 * private page is not, and its title must never reach a chunk someone else can be shown. The tool
 * itself draws that distinction — PageLink has a `no-access` state and withholds the title.
 */
it.skipIf(!url)('names the page a link points to, and never names a private one', async () => {
  await db.query(
    `INSERT INTO pages(id,workspace_id,metadata,visibility) VALUES
     ('shared','w',$1,'workspace'),('secret','w',$2,'private'),('heir','w',$3,'inherit')`,
    [
      JSON.stringify({ title: 'Barème des frais' }),
      JSON.stringify({ title: 'Salaires 2026' }),
      JSON.stringify({ title: 'Notes de frais', parentId: 'shared' }),
    ],
  );
  await db.query("INSERT INTO pages(id,workspace_id,metadata,content) VALUES('liens','w',$1,$2)", [
    JSON.stringify({ title: 'Ce qu\'il faut lire' }),
    JSON.stringify({
      blocks: [
        { id: 'l1', type: 'page-link', data: { pageId: 'shared' } },
        { id: 'l2', type: 'page-link', data: { pageId: 'secret' } },
        // Visibility is inherited: this one stands under a workspace page, so it is readable too.
        { id: 'l3', type: 'page-link', data: { pageId: 'heir' } },
        { id: 'l4', type: 'page-link', data: { pageId: 'disparue' } },
      ],
    }),
  ]);
  sent.length = 0;
  const embed = createEmbeddings(master, upstream);
  while (await indexNextPage(db, embed, new AbortController().signal));

  const cited = sent.filter((input) => input.includes('Ce qu\'il faut lire'));
  expect(cited).toEqual(["Ce qu'il faut lire\nBarème des frais\nNotes de frais"]);
  // The private page is indexed under its own name, for its own readers, and nowhere else: its
  // title never travels inside a chunk belonging to a page other people can read.
  expect(sent.filter((input) => input.includes('Salaires 2026'))).toEqual(['Salaires 2026']);
});

/**
 * A chunk carries the trail of pages above it, so that trail is part of what was embedded. Rename
 * an ancestor and every passage below it is describing a page by a name it no longer has; move a
 * page and its whole trail changes. Neither re-queued anything: the trigger watched the row that
 * changed, and the children's rows had not changed.
 *
 * Renaming or moving is rare and the subtree is usually small, so the whole subtree is re-queued
 * rather than reasoned about. A stale name is worse than a few embeddings.
 */
it.skipIf(!url)('re-reads the pages below a page that is renamed or moved', async () => {
  await db.query(
    "INSERT INTO pages(id,workspace_id,metadata,content) VALUES('petit','w',$1,$2)",
    [
      JSON.stringify({ title: 'Les congés', parentId: 'depart' }),
      JSON.stringify({ blocks: [{ id: 'c1', type: 'paragraph', data: { text: [{ text: 'Poser ses jours.' }] } }] }),
    ],
  );
  const embed = createEmbeddings(master, upstream);
  while (await indexNextPage(db, embed, new AbortController().signal));

  sent.length = 0;
  await db.query("UPDATE pages SET metadata=jsonb_set(metadata,'{title}','\"Équipe\"') WHERE id='rh'");
  while (await indexNextPage(db, embed, new AbortController().signal));

  // The grandchild is two levels down, and its trail is wrong until it is read again.
  expect(sent).toContain('Équipe › Procédure de départ › Les congés\nPoser ses jours.');
  expect(sent.some((input) => input.includes('Ressources humaines'))).toBe(false);
});

/**
 * The recipe that turns a page into passages is itself versioned. A page left untouched since
 * before a recipe changed keeps vectors built the old way — and because a search only matches the
 * current profile, that page silently leaves semantic search altogether rather than ranking badly.
 *
 * The queue remembers which recipe each page was read under, so a new one re-reads exactly the
 * pages that are behind, one at a time, instead of nothing or everything.
 */
it.skipIf(!url)('re-reads pages left behind by an older recipe, and only those', async () => {
  const due = async () =>
    (await db.query<{ page_id: string }>(
      'SELECT page_id FROM page_embedding_jobs WHERE due_at IS NOT NULL ORDER BY page_id',
    )).rows.map((row) => row.page_id);

  const embed = createEmbeddings(master, upstream);
  while (await indexNextPage(db, embed, new AbortController().signal));
  expect(await due()).toEqual([]);

  await db.query("UPDATE page_embedding_jobs SET model='text-embedding-3-small:1536:v0' WHERE page_id IN ('depart','petit')");
  expect(await ensureVectorIndex(db, PROJECTION)).toBe(true);

  expect(await due()).toEqual(['depart', 'petit']);
});

/** Editing one paragraph of a long page is one passage changed, not a whole page re-paid for. */
it.skipIf(!url)('pays only for the passages whose text actually changed', async () => {
  const body = (second: string) => ({
    blocks: [
      { id: 'u1', type: 'header', data: { text: [{ text: 'Avant' }] } },
      { id: 'u2', type: 'paragraph', data: { text: [{ text: 'x'.repeat(900) }] } },
      { id: 'u3', type: 'header', data: { text: [{ text: 'Après' }] } },
      { id: 'u4', type: 'paragraph', data: { text: [{ text: second }] } },
    ],
  });
  await db.query("INSERT INTO pages(id,workspace_id,metadata,content) VALUES('long','w',$1,$2)", [
    JSON.stringify({ title: 'Une longue page' }),
    JSON.stringify(body('Première version.')),
  ]);
  const embed = createEmbeddings(master, upstream);
  while (await indexNextPage(db, embed, new AbortController().signal));

  sent.length = 0;
  await db.query("UPDATE pages SET content=$1, version=version+1 WHERE id='long'", [JSON.stringify(body('Seconde version.'))]);
  while (await indexNextPage(db, embed, new AbortController().signal));

  expect(sent).toEqual(['Une longue page — Après\nAprès\nSeconde version.']);
});
