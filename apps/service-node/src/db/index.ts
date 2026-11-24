import { drizzle } from 'drizzle-orm/node-postgres';

import type { PgPool } from './pool.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>;

export function createDb(pool: PgPool) {
  return drizzle(pool, { schema });
}

export { schema };