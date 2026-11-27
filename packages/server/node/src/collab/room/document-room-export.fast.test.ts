import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, Doc } from 'yjs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';
import { restorePage, seedUpdate } from './page-document.ts';
import { openDocumentRoom } from './document-room.ts';
import type { RoomIdentity } from './preview.ts';

/**
 * The write-back lane. The journal is the room's own record; `onExport` is how
 * the CONSUMER's record — the one every other reader of the document reads —
 * is told that it is behind. A room with no export lane commits happily and
 * leaves that record on the day the document was seeded.
 */
const origin = 'http://localhost';
const snapshot = (text: string) => ({ blocks: [{ id: 'a', type: 'paragraph', data: { text } }] });
const digestOf = (body: string) => createHash('sha256').update(body).digest();
const editor: RoomIdentity = { id: 'editor', write: true };

let root: string;
let replica: Doc;
let exported: Array<Record<string, unknown>>;
/** What the next export answers with; a rejection is an endpoint that refused. */
let answer: () => Promise<void>;

function edit(text: string): Uint8Array {
  const update = restorePage(replica, snapshot(text));

  applyUpdate(replica, update);

  return update;
}

async function openRoom(extra: Record<string, unknown> = {}, debounceMs = 10) {
  const seed = seedUpdate(snapshot('seed'));

  replica = new Doc();
  applyUpdate(replica, seed);
  await initializePage(root, 'page-1', newBaseline(seed), '{}', async () => {});

  return openDocumentRoom({
    directory: pageDirectory(root, 'page-1'),
    documentId: 'page-1',
    allowedOrigins: new Set([origin]),
    authorize: async (token) => (token === 'editor' ? editor : null),
    exportExtra: extra,
    // Short enough that a test need not sit out the real debounce; the lane
    // under test is the same one either way.
    exportDebounceMs: debounceMs,
    onExport: async (projection) => {
      exported.push(projection);
      await answer();
    },
  });
}

/** One committed edit, through the door an HTTP caller uses. */
async function commit(room: Awaited<ReturnType<typeof openRoom>>, id: string, text: string): Promise<void> {
  const outcome = await room.apply({ operationId: id.padEnd(32, '0'), digest: digestOf(text), update: edit(text) }, editor, 'editor');

  expect(outcome).toMatchObject({ ok: true });
}

async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 500; turn++) {
    if (ready()) return;
    await new Promise((wake) => setTimeout(wake, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const textOf = (projection: Record<string, unknown>): unknown =>
  (projection.blocks as Array<{ data?: { text?: unknown } }>)[0]?.data?.text;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blok-room-export-'));
  exported = [];
  answer = async () => {};
});

afterEach(async () => {
  replica?.destroy();
  await rm(root, { recursive: true, force: true });
});

it('hands the consumer the whole document after a committed edit, with the keys the record kept beside it', async () => {
  const room = await openRoom({ time: 17 });

  try {
    await commit(room, 'a', 'one');
    await waitFor(() => exported.length > 0, 'the write-back a committed edit owes');

    expect(exported[0]).toEqual({
      time: 17,
      blocks: [{ id: 'a', type: 'paragraph', data: { text: [{ text: 'one' }] } }],
    });
  } finally {
    await room.close();
  }
});

it('coalesces a burst of edits into one write-back carrying the last of them', async () => {
  // Long enough to hold all three commits, so what is measured is the
  // coalescing and not how fast the commits happened to run.
  const room = await openRoom({}, 300);

  try {
    await commit(room, 'a', 'one');
    await commit(room, 'b', 'two');
    await commit(room, 'c', 'three');
    await waitFor(() => exported.length > 0, 'the write-back the burst owes');
    // Typing is many commits and one record: a PUT per keystroke is what the
    // debounce exists to prevent.
    expect(exported).toHaveLength(1);
    expect(textOf(exported[0]!)).toEqual([{ text: 'three' }]);
  } finally {
    await room.close();
  }
});

it('writes back the last edit of a room that is closing, which has nowhere else to go', async () => {
  const room = await openRoom();

  // Closed inside the debounce window: the timer never fires, and the next
  // open reads the journal — the consumer's record never would.
  await commit(room, 'a', 'unsaved');
  await room.close();

  expect(exported).toHaveLength(1);
  expect(textOf(exported[0]!)).toEqual([{ text: 'unsaved' }]);
});

it('keeps a refused write-back owed, so the close still delivers it', async () => {
  const room = await openRoom();

  answer = () => Promise.reject(new Error('the endpoint is down'));
  try {
    await commit(room, 'a', 'one');
    await waitFor(() => exported.length > 0, 'the refused write-back');
  } finally {
    answer = async () => {};
    await room.close();
  }

  // A refusal must not spend the edit: the record is still behind, and the
  // room still owes it.
  expect(exported.length).toBeGreaterThan(1);
  expect(textOf(exported.at(-1)!)).toEqual([{ text: 'one' }]);
});

it('writes nothing back for a room that committed nothing', async () => {
  const room = await openRoom();

  await room.close();

  expect(exported).toEqual([]);
});
