import pg from 'pg';

const { Pool } = pg;

export type PgPool = InstanceType<typeof Pool>;

export function createPool(databaseUrl: string): PgPool {
  return new Pool({
    connectionString: databaseUrl,
    // No just-in-time compilation. Reading a document's text is many small jsonb subqueries, and
    // the planner prices them like a long analytical scan — far above jit_above_cost. PostgreSQL
    // then compiles the query to machine code on every call: measured at 360 ms of LLVM against
    // 1 ms of actual work, so a search took 26 s per hundred calls instead of 0.1 s. Nothing this
    // service runs is analytical; every query answers one request and returns a handful of rows.
    options: '-c jit=off',
    max: 20,
    idleTimeoutMillis: 30_000,
  });
}