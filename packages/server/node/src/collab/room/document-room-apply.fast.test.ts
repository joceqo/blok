import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';
import { restorePage, seedUpdate } from './page-document.ts';
import { MAX_APPEND_BYTES } from '../journal/append.ts';
import { openDocumentRoom } from './document-room.ts';
import { EditRefused, EditTooLarge } from '../edit/apply.ts';
import type { RoomIdentity } from './preview.ts';

const origin = 'http://localhost';
const snapshot = (text: string) => ({ blocks: [{ id: 'a', type: 'paragraph', data: { text } }] });
const digestOf = (body: string) => createHash('sha256').update(body).digest();

let root: string;
let room: Awaited<ReturnType<typeof openDocumentRoom>>;
let lineage: string;
/** A replica of the room's document, so a test can craft an update the room will accept. */
let replica: Doc;

const editor: RoomIdentity = { id: 'editor', write: true };
const viewer: RoomIdentity = { id: 'viewer', write: false };

/** The update that takes the replica from its current text to `text`. */
function edit(text: string) {
  const update = restorePage(replica, snapshot(text));
  applyUpdate(replica, update);
  return update;
}

/**
 * The same, for an update the room is expected to refuse. It is crafted off a
 * throwaway copy so the replica stays what it claims to be — a replica of the
 * room's document. Advancing the replica by a refused edit would leave every
 * later update referring to structs the room never saw, which is not the
 * precondition this door is meant to be exercised under.
 */
function strayEdit(text: string) {
  const aside = new Doc();
  applyUpdate(aside, encodeStateAsUpdate(replica));
  try {
    return restorePage(aside, snapshot(text));
  } finally {
    aside.destroy();
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blok-room-apply-'));
  const seed = seedUpdate(snapshot('seed'));
  const baseline = newBaseline(seed);
  lineage = Buffer.from(baseline.lineage).toString('hex');
  replica = new Doc();
  applyUpdate(replica, seed);
  await initializePage(root, 'page-1', baseline, '{}', async () => {});
  room = await openDocumentRoom({
    directory: pageDirectory(root, 'page-1'),
    documentId: 'page-1',
    allowedOrigins: new Set([origin]),
    authorize: async (token) => (token === 'editor' ? editor : token === 'viewer' ? viewer : null),
  });
});

afterEach(async () => {
  replica?.destroy();
  await room?.close();
  await rm(root, { recursive: true, force: true });
});

it('commits an edit and reports the lineage and the sequence it committed at', async () => {
  const first = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'), update: edit('one') }, editor, 'editor');

  expect(first).toEqual({ ok: true, lineage, sequence: 1n });

  const second = await room.apply({ operationId: 'b'.repeat(32), digest: digestOf('two'), update: edit('two') }, editor, 'editor');

  expect(second).toEqual({ ok: true, lineage, sequence: 2n });
});

it('returns the original receipt for a replayed key and spends no sequence on it (S1)', async () => {
  const update = edit('one');
  const first = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'), update }, editor, 'editor');
  await room.apply({ operationId: 'b'.repeat(32), digest: digestOf('two'), update: edit('two') }, editor, 'editor');

  const replay = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'), update }, editor, 'editor');

  expect(replay).toEqual(first);
  // The replay appended nothing, so the next edit takes the sequence after the second one.
  const next = await room.apply({ operationId: 'c'.repeat(32), digest: digestOf('three'), update: edit('three') }, editor, 'editor');
  expect(next).toEqual({ ok: true, lineage, sequence: 3n });
});

it('refuses a known key carrying a different body as a conflict and applies nothing', async () => {
  await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'), update: edit('one') }, editor, 'editor');

  const conflict = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('other'), update: strayEdit('other') }, editor, 'editor');

  expect(conflict).toEqual({ ok: false, reason: 'conflict' });
  const next = await room.apply({ operationId: 'b'.repeat(32), digest: digestOf('two'), update: edit('two') }, editor, 'editor');
  expect(next).toEqual({ ok: true, lineage, sequence: 2n });
});

it('fails the precondition with the current head when the expected point no longer matches', async () => {
  await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'), update: edit('one') }, editor, 'editor');

  const stale = await room.apply({ operationId: 'b'.repeat(32), digest: digestOf('two'), update: edit('two'),
    expected: { lineage, sequence: 0n } }, editor, 'editor');

  expect(stale).toEqual({ ok: false, reason: 'precondition', lineage, sequence: 1n });
  const wrongLineage = await room.apply({ operationId: 'c'.repeat(32), digest: digestOf('two'), update: edit('two'),
    expected: { lineage: 'f'.repeat(32), sequence: 1n } }, editor, 'editor');
  expect(wrongLineage).toEqual({ ok: false, reason: 'precondition', lineage, sequence: 1n });
});

it('commits under a matching expected point and still answers a replayed key from its receipt', async () => {
  const guarded = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'), update: edit('one'),
    expected: { lineage, sequence: 0n } }, editor, 'editor');

  expect(guarded).toEqual({ ok: true, lineage, sequence: 1n });

  await room.apply({ operationId: 'b'.repeat(32), digest: digestOf('two'), update: edit('two') }, editor, 'editor');
  // Section 12.2: a committed key answers its first receipt, even behind a tag that no longer matches.
  const replay = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'), update: edit('one'),
    expected: { lineage, sequence: 0n } }, editor, 'editor');

  expect(replay).toEqual({ ok: true, lineage, sequence: 1n });
});

it('refuses an update past the journal append limit', async () => {
  const tooLarge = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('big'),
    update: new Uint8Array(MAX_APPEND_BYTES + 1) }, editor, 'editor');

  expect(tooLarge).toEqual({ ok: false, reason: 'too-large' });
});

it('refuses an update the engine cannot integrate', async () => {
  const invalid = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('bad'),
    update: Uint8Array.of(0xff, 0xff, 0xff, 0xff) }, editor, 'editor');

  expect(invalid).toEqual({ ok: false, reason: 'invalid' });
});

it('answers an edit that changes nothing with the current head and records nothing under its key', async () => {
  const update = edit('one');
  await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'), update }, editor, 'editor');

  const noop = await room.apply({ operationId: 'b'.repeat(32), digest: digestOf('again'), update }, editor, 'editor');

  expect(noop).toEqual({ ok: true, lineage, sequence: 1n });
  // Nothing was recorded under that key, so another body under it is applied, not a conflict.
  const reuse = await room.apply({ operationId: 'b'.repeat(32), digest: digestOf('two'), update: edit('two') }, editor, 'editor');
  expect(reuse).toEqual({ ok: true, lineage, sequence: 2n });
});

it('refuses a caller without write permission and applies nothing', async () => {
  const refused = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'), update: strayEdit('one') }, viewer, 'viewer');

  expect(refused).toEqual({ ok: false, reason: 'forbidden' });
  const next = await room.apply({ operationId: 'b'.repeat(32), digest: digestOf('two'), update: edit('two') }, editor, 'editor');
  expect(next).toEqual({ ok: true, lineage, sequence: 1n });
});

it('answers a builder\'s refusal in its own words, and keeps the HTML cap apart from the rest', async () => {
  const words = 'collab: rich text field "paragraph.text" holds 32769 HTML characters; an edit may send at most 32768.';
  const oversized = await room.apply({ operationId: 'a'.repeat(32), digest: digestOf('big'), update: new Uint8Array(),
    build: () => { throw new EditTooLarge(words); } }, editor, 'editor');

  expect(oversized).toEqual({ ok: false, reason: 'too-large', message: words });

  const refused = await room.apply({ operationId: 'b'.repeat(32), digest: digestOf('no'), update: new Uint8Array(),
    build: () => { throw new EditRefused('collab: op 0: there is no block "a" to update.'); } }, editor, 'editor');

  expect(refused).toEqual({ ok: false, reason: 'invalid', message: 'collab: op 0: there is no block "a" to update.' });
});

/** A room of this test's own, so it can choose the options it opens with. */
async function roomWith(page: string, extra: { recordNotes?: boolean }) {
  const baseline = newBaseline(seedUpdate(snapshot('seed')));

  await initializePage(root, page, baseline, '{}', async () => {});

  const opened = await openDocumentRoom({
    directory: pageDirectory(root, page),
    documentId: page,
    allowedOrigins: new Set([origin]),
    authorize: async (token) => (token === 'editor' ? editor : null),
    ...extra,
  });

  return { room: opened, lineage: Buffer.from(baseline.lineage).toString('hex') };
}

it('hands its record-notes setting down to the history routes', async () => {
  const quiet = await roomWith('page-quiet', { recordNotes: false });

  try {
    const wrote = await quiet.room.apply({ operationId: 'a'.repeat(32), digest: digestOf('one'),
      update: new Uint8Array(), build: (live) => restorePage(live, snapshot('one')) }, editor, 'editor');

    expect(wrote).toEqual({ ok: true, lineage: quiet.lineage, sequence: 1n });

    const answer = await quiet.room.history({
      url: new URL(`http://host/api/blok/sync/page-quiet/history/${quiet.lineage}/1/changes`),
      method: 'GET',
      confirmed: [],
    }, editor, 'editor');
    const rows = (answer.body as { changes: Record<string, unknown>[] }).changes;

    expect(answer.status).toBe(200);
    expect(rows.length).toBeGreaterThan(0);
    // A host keeping no record-notes store must not answer an empty actor
    // list for every record: the key is absent, not empty.
    expect(rows.filter((row) => Object.hasOwn(row, 'actors'))).toEqual([]);
  } finally {
    await quiet.room.close();
  }
});
