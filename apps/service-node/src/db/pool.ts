import pg from 'pg';

const { Pool } = pg;

export type PgPool = InstanceType<typeof Pool>;

export function createPool(databaseUrl: string): PgPool {
  return new Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
  });
}