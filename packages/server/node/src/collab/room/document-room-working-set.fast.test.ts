// A room given a working-set store keeps no journal: the store is the whole
// of its durability, as Go's room is when --collab-s3-prefix names one.
import { createHash } from 'node:crypto';
import { applyUpdate, Doc } from 'yjs';
import { afterEach, expect, it } from 'vitest';
import { openDocumentRoom } from './document-room.ts';
import { restorePage, seedUpdate } from './page-document.ts';
import { S3WorkingSetStore, type ObjectStore } from './s3-working-set.ts';
import { docKey } from './working-set.ts';
import type { RoomIdentity } from './preview.ts';

const origin = 'http://localhost';
const editor: RoomIdentity = { id: 'editor', write: true };
const snapshot = (text: string) => ({ blocks: [{ id: 'a', type: 'paragraph', data: { text } }] });
const digestOf = (body: string) => createHash('sha256').update(body).digest();

/** The bucket, with every key it was ever asked for. */
class Bucket implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  refuse = false;

  async getObject(key: string): Promise<Buffer | undefined> {
    this.reads.push(key);
    return this.objects.get(key);
  }

  async putObject(key: string, content: Buffer): Promise<void> {
    if (this.refuse) throw new Error('blobstore: s3 PUT returned 503');
    this.writes.push(key);
    this.objects.set(key, content);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const rooms: Awaited<ReturnType<typeof openDocumentRoom>>[] = [];

/** A room whose only durability is `bucket`; `directory` names nothing on disk. */
async function openOver(bucket: Bucket, seed?: Uint8Array) {
  const room = await openDocumentRoom({
    directory: '/nonexistent/working-set-room',
    documentId: 'page-1',
    allowedOrigins: new Set([origin]),
    authorize: async (token) => (token === 'editor' ? editor : null),
    workingSets: new S3WorkingSetStore(bucket, '/collab/'),
    ...(seed === undefined ? {} : { workingSetSeed: async () => seed }),
  });
  rooms.push(room);
  return room;
}

/** The update that takes a fresh replica of the room's document to `text`. */
function edit(replica: Doc, text: string) {
  const update = restorePage(replica, snapshot(text));
  applyUpdate(replica, update);
  return update;
}

const stateRequest = { url: new URL('/api/blok/sync/page-1/state', origin), method: 'GET', confirmed: [] };

/** Each block as its id and its flattened text, which is all these tests read. */
async function blocksOf(room: Awaited<ReturnType<typeof openDocumentRoom>>) {
  const answer = await room.history(stateRequest, editor, 'editor');
  const body = answer.body as { blocks: { id: string; data: { text: { text: string }[] } }[] };
  return body.blocks.map((block) => ({ id: block.id, text: block.data.text.map((run) => run.text).join('') }));
}

afterEach(async () => {
  await Promise.all(rooms.splice(0).map((room) => room.close().catch(() => {})));
});

it('opens with no journal at all and publishes the whole state under the prefix', async () => {
  const bucket = new Bucket();
  const room = await openOver(bucket, seedUpdate(null));
  const replica = new Doc();

  const committed = await room.apply(
    { operationId: 'a'.repeat(32), digest: digestOf('one'), update: edit(replica, 'one') },
    editor,
    'editor',
  );

  expect(committed.ok).toBe(true);
  expect(bucket.writes).toEqual([`collab/${docKey('page-1')}`]);
  expect(bucket.objects.get(`collab/${docKey('page-1')}`)?.subarray(0, 4).toString('latin1')).toBe('BKW2');
  replica.destroy();
});

it('serves the edit again from the store alone, with the lineage the first room published', async () => {
  const bucket = new Bucket();
  const first = await openOver(bucket, seedUpdate(null));
  const replica = new Doc();
  const committed = await first.apply(
    { operationId: 'a'.repeat(32), digest: digestOf('one'), update: edit(replica, 'one') },
    editor,
    'editor',
  );

  await first.close();

  const second = await openOver(bucket, seedUpdate(null));

  expect(await blocksOf(second)).toEqual([{ id: 'a', text: 'one' }]);
  expect((await second.history(stateRequest, editor, 'editor')).headers?.['Blok-Doc-Lineage'])
    .toBe(committed.ok && committed.lineage);
  replica.destroy();
});

it('starts from the seed when the store holds nothing, and reads the key once', async () => {
  const bucket = new Bucket();
  const room = await openOver(bucket, seedUpdate(snapshot('from the endpoint')));

  expect(await blocksOf(room)).toEqual([{ id: 'a', text: 'from the endpoint' }]);
  expect(bucket.reads).toEqual([`collab/${docKey('page-1')}`]);
});

it('refuses the edit when the store will not take it, rather than acknowledging a lost one', async () => {
  const bucket = new Bucket();
  const room = await openOver(bucket, seedUpdate(null));
  const replica = new Doc();

  bucket.refuse = true;

  await expect(room.apply(
    { operationId: 'a'.repeat(32), digest: digestOf('one'), update: edit(replica, 'one') },
    editor,
    'editor',
  )).rejects.toThrow();
  expect(room.available()).toBe(false);
  replica.destroy();
});
