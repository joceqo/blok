import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultTestHostOptions } from '../test-kit/invoke-host.ts';
import type { HostAppOptions } from './options.ts';

/**
 * The room is stubbed because the three flags below are the host's side of the
 * contract: `main.ts` reads them off the command line and this file is the only
 * place that hands them on. What the room then does with them is its own test.
 */
const { openDocumentRoom } = vi.hoisted(() => ({ openDocumentRoom: vi.fn() }));

vi.mock('../collab/room/document-room.ts', () => ({ openDocumentRoom }));

const { createSyncRooms } = await import('./sync-room.ts');

const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  openDocumentRoom.mockResolvedValue({
    connect: () => {},
    apply: async () => ({ ok: true, lineage: 'l', sequence: 0n }),
    history: async () => ({ status: 200 }),
    recheck: async () => {},
    close: async () => {},
    available: () => true,
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

/** Opens one room, and answers the options it was opened with. */
async function openedWith(overrides: Partial<HostAppOptions>): Promise<Record<string, unknown>> {
  const collabDirectory = await mkdtemp(join(tmpdir(), 'blok-sync-room-options-'));
  const rooms = createSyncRooms({
    ...defaultTestHostOptions(),
    collabEnabled: true,
    collabDirectory,
    ...overrides,
  });

  cleanups.push(() => rooms.close());
  cleanups.push(() => rm(collabDirectory, { recursive: true, force: true }));

  await rooms.apply('d', '', { operationId: 'k1', digest: new Uint8Array(32), update: new Uint8Array() });

  const call = openDocumentRoom.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

  if (call === undefined) {
    throw new Error('the room was never opened');
  }

  return call;
}

describe('createSyncRooms options', () => {
  it('hands the record-note and restore flags to the room', async () => {
    expect(await openedWith({
      collabRecordNotes: true,
      collabEnforceRestoreGuards: true,
      collabRestoreTrashesPages: true,
    })).toMatchObject({
      documentId: 'd',
      recordNotes: true,
      enforceRestoreGuards: true,
      restoreTrashesPages: true,
    });
  });

  it('reads an unset restore flag as off, never as absent', async () => {
    expect(await openedWith({})).toMatchObject({
      enforceRestoreGuards: false,
      restoreTrashesPages: false,
    });
  });
});
