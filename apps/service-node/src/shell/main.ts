import { roomPurger, startPurgeRetries } from './page-purge.ts';
import { loadAiKey } from './ai-crypto.ts';
import { deviceCredential, ensureDeviceAccount } from './device-account.ts';
import { bootstrapShell, inTransaction } from './bootstrap.ts';
import { serve } from '@hono/node-server';
import { createPool } from '../db/pool.ts';
import { createShellApp } from './app.ts';

import { createEmbeddings, PROJECTION, startEmbeddingWorker } from './embeddings.ts';
import { ensureVectorIndex } from './vector-index.ts';

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
if (deviceCredential(process.env.BLOK_DEVICE_SESSION_SECRET)) {
  if (process.env.BLOK_LISTEN_HOST !== '127.0.0.1') throw new Error('Embedded sessions require a loopback listener');
  await inTransaction(pool, ensureDeviceAccount);
}
const master = await loadAiKey(pool, process.env.DATA_DIRECTORY ?? './data', process.env.AI_ENCRYPTION_KEY);
const embed = await ensureVectorIndex(pool, PROJECTION) ? createEmbeddings(master,fetch,pool) : undefined;
const stopEmbeddings = embed && startEmbeddingWorker(pool,embed);
const app = createShellApp(pool, process.env.INTERNAL_SECRET ?? '', origins, undefined, undefined, embed);
const stopPurgeRetries = startPurgeRetries(pool, roomPurger(process.env.INTERNAL_SECRET!));
const server = serve({ fetch: app.fetch, port, hostname: process.env.BLOK_LISTEN_HOST }, () => console.info(`Shell backend listening on port ${port}`));

function shutdown() {
  server.close(() => { void Promise.all([stopPurgeRetries(),stopEmbeddings?.()]).then(() => pool.end()); });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
