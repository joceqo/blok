import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { pageBlockText, pageSearchText } from './page-search-text.ts';

const url = process.env.SHELL_TEST_DATABASE_URL;
const schema = 'test_extract_' + randomUUID().replaceAll('-', '');
const db = new pg.Pool({ connectionString: url, options: '-csearch_path=' + schema + ',public -c jit=off' });

beforeAll(async () => {
  if (!url) return;
  await db.query('CREATE SCHEMA ' + schema);
  await db.query(await readFile(new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
  await db.query("INSERT INTO workspaces(id,slug,name) VALUES('w','demo','Demo')");
});
afterAll(async () => {
  if (url) await db.query('DROP SCHEMA ' + schema + ' CASCADE');
  await db.end();
});

/** The words the index holds for a page made of these blocks, through the shipped extractor. */
const indexed = async (blocks: unknown[]) => {
  await db.query("DELETE FROM pages WHERE id='p'");
  await db.query("INSERT INTO pages(id,workspace_id,metadata,content) VALUES('p','w','{}',$1)", [
    JSON.stringify({ blocks }),
  ]);
  const { rows } = await db.query<{ text: string }>(
    `SELECT ${pageSearchText} AS text FROM pages p WHERE p.id='p'`,
  );

  return rows[0]!.text;
};

/** The same page, one row per block, as a search uses it to cite the block a match came from. */
const perBlock = async (blocks: unknown[]) => {
  await indexed(blocks);
  const { rows } = await db.query<{ block_id: string; body: string }>(
    `SELECT parts.block_id, parts.body FROM pages p
     LEFT JOIN LATERAL ${pageBlockText} parts ON true WHERE p.id='p' ORDER BY parts.ord`,
  );

  return new Map(rows.map((row) => [row.block_id, row.body]));
};

/**
 * A database row IS a block, and its columns are its content. They were invisible to the index:
 * `data.properties` was never read, so a whole tracker searched as its titles alone.
 *
 * A choice is named by its label, and the label lives on the database, not on the row — which is
 * also where the word belongs. "En attente" describes the tracker; it does not describe any one
 * task. The id the row actually stores is never indexed: it is a word no one can read.
 */
it.skipIf(!url)('reads a row\'s written columns, and a database\'s own vocabulary', async () => {
  const bodies = await perBlock([
    {
      id: 'db',
      type: 'database',
      data: {
        title: 'Démarches',
        description: 'Ce qu\'il faut <b>faire</b> avant de partir.',
        schema: [
          { id: 'p-title', name: 'Nom', type: 'title', position: 'a0' },
          {
            id: 'p-state',
            name: 'État',
            type: 'status',
            position: 'a1',
            config: { options: [{ id: 'o-wait', label: 'En attente', position: 'a0' }] },
          },
          { id: 'p-note', name: 'Note', type: 'text', position: 'a2' },
          { id: 'p-long', name: 'Pièces', type: 'richText', position: 'a3' },
        ],
      },
    },
    {
      id: 'row',
      type: 'database-row',
      parent: 'db',
      data: {
        title: 'Renouveler le passeport',
        properties: {
          'p-title': 'Renouveler le passeport',
          'p-state': 'o-wait',
          'p-note': [{ text: 'Rendez-vous en mairie' }],
          'p-long': { blocks: [{ id: 'n', type: 'paragraph', data: { text: [{ text: 'Pièces à fournir' }] } }] },
        },
      },
    },
  ]);

  // A value says what it is only when its column names it: "En attente" alone could be anything,
  // "État : En attente" answers "quelles démarches sont en attente ?". Columns read in their own
  // order, so the same row always reads the same way.
  expect(bodies.get('row')).toBe(
    'Renouveler le passeport Nom : Renouveler le passeport · État : En attente'
      + ' · Note : Rendez-vous en mairie · Pièces : Pièces à fournir',
  );
  expect(bodies.get('db')).toContain('En attente');
  expect(bodies.get('db')).toContain('État');
  expect(bodies.get('db')).toContain('Démarches');
  // The line under a database's title is the one place someone explains what it is for.
  expect(bodies.get('db')).toContain('avant de partir');
  expect(bodies.get('db')).not.toContain('<b>');
  expect([...bodies.values()].join(' ')).not.toContain('o-wait');
});

/** What someone wrote about a picture is the only thing a text index can know about it. */
it.skipIf(!url)('reads an image\'s alternative text, and leaves its address out', async () => {
  const text = await indexed([
    {
      id: 'photo',
      type: 'image',
      data: {
        url: 'https://example.test/loutre-9f3b.jpg',
        alt: 'Une loutre sur un rocher',
        fileName: 'bord de Loire.jpg',
        caption: [{ text: 'Au bord de la Loire' }],
      },
    },
  ]);

  expect(text).toContain('Une loutre sur un rocher');
  expect(text).toContain('Au bord de la Loire');
  expect(text).toContain('bord de Loire.jpg');
  expect(text).not.toContain('loutre-9f3b');
});

/** The shapes that already worked keep working. */
it.skipIf(!url)('still reads segments, bare strings and code', async () => {
  const text = await indexed([
    { id: 'a', type: 'paragraph', data: { text: [{ text: 'Le héron pêche.' }] } },
    { id: 'b', type: 'header', data: { text: 'La marmotte dort.' } },
    { id: 'c', type: 'code', data: { code: 'const faon = 3;' } },
  ]);

  expect(text).toContain('Le héron pêche.');
  expect(text).toContain('La marmotte dort.');
  expect(text).toContain('const faon = 3;');
});
