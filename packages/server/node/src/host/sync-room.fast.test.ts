import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CollabLog } from '../collab/log.ts';
import { defaultTestHostOptions } from '../test-kit/invoke-host.ts';
import type { HostAppOptions } from './options.ts';
import { createSyncRooms, type SyncRooms } from './sync-room.ts';

interface FakeEndpoint {
  url: string;
  /** One entry per document fetched. */
  gets: string[];
  stop(): Promise<void>;
}

/** A doc endpoint that answers an empty page and counts what was asked of it. */
async function startEndpoint(): Promise<FakeEndpoint> {
  const gets: string[] = [];
  const server: Server = createServer((request, response) => {
    gets.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ blocks: [] }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }

  return {
    url: `http://127.0.0.1:${address.port}/docs`,
    gets,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A collaboration directory, removed after every host that reads it has closed. */
async function collabDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'blok-sync-room-'));

  cleanups.push(() => rm(directory, { recursive: true, force: true }));

  return directory;
}

async function collabHost(overrides: Partial<HostAppOptions>): Promise<SyncRooms> {
  const rooms = createSyncRooms({
    ...defaultTestHostOptions(),
    collabEnabled: true,
    collabDirectory: overrides.collabDirectory ?? (await collabDirectory()),
    ...overrides,
  });

  cleanups.push(() => rooms.close());

  return rooms;
}

describe('createSyncRooms', () => {
  it('journalises a document it could not load, and still refuses the caller', async () => {
    const logged: [string, string][] = [];
    const collabLog: CollabLog = (message, level) => logged.push([level, message]);
    const rooms = await collabHost({
      collabLog,
      docEndpoint: 'http://127.0.0.1:1/docs',
      // Only this host knows the credential is unsendable; the socket is
      // refused without a word unless the room says so here.
      docEndpointAuth: 'token\nerror: forged',
    });

    await expect(rooms.apply('d', '', {
      operationId: 'k1',
      digest: new Uint8Array(32),
      update: new Uint8Array(),
    })).rejects.toThrow();

    expect(logged).toEqual([[
      'warning',
      'collab: room "d" could not load: collab: the doc endpoint Authorization value cannot be sent as a header (a stray newline?).',
    ]]);
  });

  it('names the document it could not load exactly as it was asked for', async () => {
    const logged: string[] = [];
    const rooms = await collabHost({
      collabLog: (message) => logged.push(message),
      docEndpoint: 'http://127.0.0.1:1/docs',
      docEndpointAuth: 'token\nerror: forged',
    });

    await expect(rooms.apply('a\nerror: forged', '', {
      operationId: 'k1',
      digest: new Uint8Array(32),
      update: new Uint8Array(),
    })).rejects.toThrow();

    expect(logged[0]).toContain('collab: room "a\nerror: forged" could not load: ');
  });

  it('reseeds a reset document from the endpoint, not as an empty one', async () => {
    const endpoint = await startEndpoint();

    cleanups.push(() => endpoint.stop());

    const rooms = await collabHost({ docEndpoint: endpoint.url });

    expect(await rooms.reset('d')).toBe(204);
    // Once to seed the document, once to reseed the fresh generation over it.
    expect(endpoint.gets).toHaveLength(2);
  });

  it('lists the history of a document another host holds, and still refuses its live doors', async () => {
    const directory = await collabDirectory();
    const holder = await collabHost({ collabDirectory: directory });
    const ask = (tail: string, method = 'GET') => ({
      url: new URL('http://host/api/blok/sync/held' + tail),
      method,
      confirmed: [],
    });

    // Loading the room is what takes the document's journal lease, and the
    // holder keeps it after the request that opened it has gone.
    expect((await holder.history('held', '', ask('/state'))).status).toBe(200);

    const other = await collabHost({ collabDirectory: directory });

    // Every door that reads the live document needs that lease, so it is refused.
    await expect(other.history('held', '', ask('/state'))).rejects.toThrow();
    await expect(other.apply('held', '', {
      operationId: 'k1',
      digest: new Uint8Array(32),
      update: new Uint8Array(),
    })).rejects.toThrow();
    expect(await other.reset('held')).toBe(503);

    // History reads take no lock. They read the journal the holder's room
    // opened: a read resolving any other directory would find no lineage.
    const list = await other.history('held', '', ask('/history'));

    expect([list.status, (list.body as { versions: { sequence: number }[] }).versions.map((v) => v.sequence)])
      .toEqual([200, [0]]);
  });
});
