import { drizzle } from 'drizzle-orm/node-postgres';

import type { PgPool } from './pool.ts';
import * as schema from './schema.ts';

export type Database = ReturnType<typeof createDb>;

export function createDb(pool: PgPool) {
  return drizzle(pool, { schema });
}

export { schema };