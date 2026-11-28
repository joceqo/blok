import { readFile } from 'node:fs/promises';

import type { PgPool } from './pool.ts';

/**
 * Applies schema.sql when SCHEMA_SQL_PATH (or default beside package) is set.
 * Mirrors Go startup: one file, no drizzle-kit migrate.
 */
export async function applySchemaIfPresent(pool: PgPool, schemaPath: string | undefined): Promise<void> {
  if (schemaPath === undefined || schemaPath.length === 0) {
    return;
  }
  const sql = await readFile(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}