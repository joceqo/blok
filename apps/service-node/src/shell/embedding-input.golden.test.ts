import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sealAiKey } from './ai-crypto.ts';
import { createEmbeddings, indexNextPage } from './embeddings.ts';
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
  expect(await ensureVectorIndex(db)).toBe(true);
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
