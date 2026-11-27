import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureVectorIndex } from './vector-index.ts';

// Une base avec pgvector : sans elle, rien à prouver sur le chemin nominal.
const databaseUrl = process.env.VECTOR_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('ensureVectorIndex', () => {
  const schema = 'test_vector_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const db = new pg.Pool({ connectionString: databaseUrl, options: '-csearch_path=' + schema + ',public' });

  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    await db.query(await readFile(new URL('../../../service/schema.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => {
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await db.end();
    await admin.end();
  });

  it('creates the chunk table when the extension is there, and says so', async () => {
    expect(await ensureVectorIndex(db)).toBe(true);

    const { rows } = await db.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name',
      [schema, 'page_chunks'],
    );
    expect(rows.map(row => row.column_name)).toEqual(
      ['block_ids', 'chunk_index', 'created_at', 'embedding', 'id', 'model', 'page_id', 'page_version', 'text', 'workspace_id'],
    );
  });

  it('runs twice without complaining, since every start calls it', async () => {
    expect(await ensureVectorIndex(db)).toBe(true);
    expect(await ensureVectorIndex(db)).toBe(true);
  });

  it('reports the index as unavailable rather than throwing when the extension is missing', async () => {
    // Un pool qui refuse la création d'extension, comme un Postgres sans pgvector installé.
    const refusing = {
      query: async (text: string) => {
        if (/CREATE EXTENSION/i.test(text)) throw new Error('could not open extension control file "vector"');
        return { rows: [] };
      },
    };

    expect(await ensureVectorIndex(refusing as unknown as pg.Pool)).toBe(false);
  });
});
