// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `apps/service-node/schema.sql` is the bootstrap source of truth; Drizzle
 * `src/db/schema.ts` is a hand-maintained subset for early routes.
 *
 * Full parity is future work: run `drizzle-kit pull` against a DB with
 * `schema.sql` applied and replace the hand-written tables (never let them drift
 * silently in the meantime).
 */

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

const sqlTableNames = (sql: string): string[] =>
  Array.from(sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g), (m) => m[1]);

const drizzleTableNames = (source: string): string[] =>
  Array.from(source.matchAll(/pgTable\(\s*'([^']+)'/g), (m) => m[1]);

const PLAN_KEY_TABLES = [
  'users',
  'workspaces',
  'pages',
  'page_documents',
  'audit_events',
  'teamspaces',
] as const;

describe('service-node schema drift law', () => {
  it('schema.sql defines the plan’s key tables', () => {
    const tables = new Set(sqlTableNames(read('apps/service-node/schema.sql')));
    const missing = PLAN_KEY_TABLES.filter((name) => !tables.has(name));

    expect(missing, `schema.sql missing tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('drizzle schema.ts covers every SQL table name (bootstrap floor ≥ 12)', () => {
    const sql = read('apps/service-node/schema.sql');
    const drizzle = read('apps/service-node/src/db/schema.ts');

    const sqlNames = new Set(sqlTableNames(sql));
    const drizzleNames = new Set(drizzleTableNames(drizzle));

    const matching = [...sqlNames].filter((name) => drizzleNames.has(name));

    expect(
      matching.length,
      `drizzle only mirrors ${matching.length}/${sqlNames.size} SQL tables; missing: ${[...sqlNames]
        .filter((n) => !drizzleNames.has(n))
        .join(', ')}`,
    ).toBeGreaterThanOrEqual(12);

    for (const key of PLAN_KEY_TABLES) {
      expect(drizzleNames.has(key), `drizzle schema.ts missing ${key}`).toBe(true);
    }
  });
});