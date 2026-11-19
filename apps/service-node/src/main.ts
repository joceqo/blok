import { serve } from '@hono/node-server';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { applySchemaIfPresent } from './db/apply-schema.js';
import { createDb } from './db/index.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSchema = join(packageRoot, 'schema.sql');
const schemaPath = config.schemaSqlPath ?? defaultSchema;

const pool = config.databaseUrl !== undefined ? createPool(config.databaseUrl) : undefined;
if (pool !== undefined && process.env.APPLY_SCHEMA_ON_BOOT === '1') {
  await applySchemaIfPresent(pool, schemaPath);
}
const database = pool !== undefined ? createDb(pool) : undefined;

const app = createApp({ database });

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(`service-node listening on http://127.0.0.1:${info.port}`);
    if (config.databaseUrl === undefined) {
      console.log('DATABASE_URL unset — API routes return 503');
    }
  },
);

async function shutdown(): Promise<void> {
  server.close();
  if (pool !== undefined) {
    await pool.end();
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().then(() => process.exit(0));
  });
}