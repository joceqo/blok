import { loadAiKey } from './ai-crypto.ts';
import { bootstrapShell } from './bootstrap.ts';
import { serve } from '@hono/node-server';
import { createPool } from '../db/pool.ts';
import { createShellApp } from './app.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const port = Number(process.env.PORT ?? 8081);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const origins = new Set([process.env.PUBLIC_URL, ...(process.env.ALLOWED_ORIGINS ?? '').split(',')]
  .map((value) => value?.trim().replace(/\/$/, '') ?? '').filter(Boolean));
const pool = createPool(databaseUrl);
if ((process.env.TICKET_SECRET?.length ?? 0) < 32) throw new Error('TICKET_SECRET must have at least 32 characters');
process.env.BLOK_NODE_ROOM_ALL = '1';
await bootstrapShell(pool);
await loadAiKey(pool, process.env.DATA_DIRECTORY ?? './data', process.env.AI_ENCRYPTION_KEY);
const app = createShellApp(pool, process.env.INTERNAL_SECRET ?? '', origins);
const server = serve({ fetch: app.fetch, port }, () => console.info(`Shell backend listening on port ${port}`));

function shutdown() {
  server.close(() => { void pool.end(); });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
