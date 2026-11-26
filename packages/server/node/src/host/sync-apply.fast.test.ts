import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Doc } from 'yjs';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { exportPage, restorePage } from '../collab/room/page-document.ts';
import { defaultTestHostOptions } from '../test-kit/invoke-host.ts';
import type { HostAppOptions } from './options.ts';
import { createSyncRooms, type SyncRooms } from './sync-room.ts';

/**
 * The host's edit door, one layer below the route. What it owes a caller is
 * the room's own answer — taken on the shared lease a reader takes, never the
 * exclusive one a reset takes — and a refusal rather than a throw when the
 * pass names nobody.
 */

const snapshot = (text: string) => ({ blocks: [{ id: 'a', type: 'paragraph', data: { text } }] });
const digestOf = (body: string) => createHash('sha256').update(body).digest();
const textOf = (doc: Doc) => JSON.stringify(exportPage(doc, {}));

let options: HostAppOptions;
let rooms: SyncRooms;

function hostOn(auth: string): SyncRooms {
  return createSyncRooms({ ...options, auth, secret: auth === 'ticket' ? 'secret' : '' });
}

beforeEach(async () => {
  options = {
    ...defaultTestHostOptions(),
    collabEnabled: true,
    collabJournal: true,
    collabDirectory: await mkdtemp(join(tmpdir(), 'blok-sync-apply-')),
  };
  rooms = hostOn('none');
});

afterEach(async () => {
  await rooms.close();
  await rm(options.collabDirectory, { recursive: true, force: true });
  await rm(options.storageDirectory, { recursive: true, force: true });
});

it('commits a command whose update is built against the live document', async () => {
  // An empty `update`: only the builder's answer can be what the room commits.
  const first = await rooms.apply('d', '', {
    operationId: 'a'.repeat(32),
    digest: digestOf('one'),
    update: new Uint8Array(),
    build: (doc) => restorePage(doc, snapshot('one')),
  });

  expect(first).toEqual({ ok: true, lineage: expect.stringMatching(/^[0-9a-f]{32}$/), sequence: 1n });

  const seen: string[] = [];
  const second = await rooms.apply('d', '', {
    operationId: 'b'.repeat(32),
    digest: digestOf('two'),
    update: new Uint8Array(),
    build: (doc) => {
      seen.push(textOf(doc));
      return restorePage(doc, snapshot('two'));
    },
  });

  // The builder read the committed state, not the one the caller last saw.
  expect(seen[0]).toContain('one');
  expect(second).toMatchObject({ ok: true, sequence: 2n });
});

it('refuses a command whose builder throws, and leaves the head where it was', async () => {
  const refused = await rooms.apply('d', '', {
    operationId: 'c'.repeat(32),
    digest: digestOf('bad'),
    update: new Uint8Array(),
    build: () => { throw new Error('no such block'); },
  });

  expect(refused).toEqual({ ok: false, reason: 'invalid' });

  const after = await rooms.apply('d', '', {
    operationId: 'd'.repeat(32),
    digest: digestOf('one'),
    update: new Uint8Array(),
    build: (doc) => restorePage(doc, snapshot('one')),
  });

  expect(after).toMatchObject({ ok: true, sequence: 1n });
});

it('refuses rather than throws when the pass names nobody', async () => {
  const guarded = hostOn('ticket');
  try {
    const outcome = await guarded.apply('d', 'not-a-pass', {
      operationId: 'e'.repeat(32),
      digest: digestOf('one'),
      update: new Uint8Array(),
      build: (doc) => restorePage(doc, snapshot('one')),
    });

    expect(outcome).toEqual({ ok: false, reason: 'forbidden' });
  } finally {
    await guarded.close();
  }
});
