import { expect, it, vi } from 'vitest';
import { LocalStore } from '../../blob/local.ts';
import { S3Store } from '../../blob/s3.ts';
import { S3WorkingSetStore, s3WorkingSets, type ObjectStore } from './s3-working-set.ts';
import { CURRENT_FORMAT, docKey, encodeDocument, encodeFrames, type Tag } from './working-set.ts';

const lineage = 'f'.repeat(32);
const tag: Tag = { format: CURRENT_FORMAT, epoch: 19n, lineage };
const update = Uint8Array.from([1, 2, 3]);

function fakeObjects(): ObjectStore & { held: Map<string, Buffer>; calls: string[] } {
  const held = new Map<string, Buffer>();
  const calls: string[] = [];
  return {
    held,
    calls,
    async getObject(key) {
      calls.push(`GET ${key}`);
      return held.get(key);
    },
    async putObject(key, content) {
      calls.push(`PUT ${key}`);
      held.set(key, content);
    },
    async deleteObject(key) {
      calls.push(`DELETE ${key}`);
      held.delete(key);
    },
  };
}

it('keeps one object per document under the trimmed prefix', async () => {
  const objects = fakeObjects();
  const store = new S3WorkingSetStore(objects, '/collab/');

  await store.write('doc-s3', encodeFrames([update]), tag);

  const key = `collab/${docKey('doc-s3')}`;

  expect([...objects.held.keys()]).toEqual([key]);
  expect(objects.held.get(key)?.subarray(0, 4).toString('latin1')).toBe('BKW2');
  expect(await store.read('doc-s3')).toEqual({ updates: encodeFrames([update]), tag });
  // A write reads nothing first: the room owns the epoch law, and a guard GET
  // would double every edit's traffic.
  expect(objects.calls).toEqual([`PUT ${key}`, `GET ${key}`]);
});

it('refuses an empty prefix, which would put working sets at the bucket root', () => {
  for (const refused of ['', '/', '///']) {
    expect(() => new S3WorkingSetStore(fakeObjects(), refused))
      .toThrow("collab: the S3 prefix must not be empty. (Parameter 'prefix')");
  }
});

it('answers nothing for a document the bucket never held', async () => {
  expect(await new S3WorkingSetStore(fakeObjects(), 'collab').read('doc-s3')).toBeUndefined();
});

it('reads an unreadable object as absent and leaves it where it is', async () => {
  const objects = fakeObjects();
  const log = vi.fn();
  const store = new S3WorkingSetStore(objects, 'collab', log);
  const key = `collab/${docKey('doc-s3')}`;

  objects.held.set(key, Buffer.from('not a working set'));

  expect(await store.read('doc-s3')).toBeUndefined();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('treating it as absent'));

  await store.retire('doc-s3');

  expect(objects.held.has(key)).toBe(true);
});

it('retires a readable object and deletes one outright', async () => {
  const objects = fakeObjects();
  const store = new S3WorkingSetStore(objects, 'collab');
  const key = `collab/${docKey('doc-s3')}`;

  await store.write('doc-s3', encodeFrames([update]), tag);
  await store.retire('doc-s3');

  expect(objects.held.has(key)).toBe(false);

  await store.write('doc-s3', encodeFrames([update]), tag);
  await store.delete('doc-s3');

  expect(objects.held.has(key)).toBe(false);
});

it('empties the log on a reset, and only for an epoch above the stored one', async () => {
  const objects = fakeObjects();
  const store = new S3WorkingSetStore(objects, 'collab');

  await store.write('doc-s3', encodeFrames([update]), tag);

  await expect(store.reset('doc-s3', { ...tag, epoch: 19n }))
    .rejects.toThrow('collab: a reset must raise the working-set epoch for "doc-s3" above 19 (got 19).');
  expect((await store.read('doc-s3'))?.updates).toEqual(encodeFrames([update]));

  await store.reset('doc-s3', { format: CURRENT_FORMAT, epoch: 20n, lineage: '0'.repeat(32) });

  expect(await store.read('doc-s3'))
    .toEqual({ updates: Buffer.alloc(0), tag: { format: CURRENT_FORMAT, epoch: 20n, lineage: '0'.repeat(32) } });
});

it('builds a store only for a host that has both a prefix and a bucket', () => {
  const bucket = new S3Store({
    endpoint: 'http://127.0.0.1:1',
    region: 'eu-central-1',
    bucket: 'media',
    accessKey: 'AKIAEXAMPLE',
    secretKey: 'conformance-secret-key',
    publicUrl: 'https://cdn.example.com/media',
    addressing: 'path',
  });

  expect(s3WorkingSets(bucket, '/collab/')).toBeInstanceOf(S3WorkingSetStore);
  expect(s3WorkingSets(bucket, '')).toBeUndefined();
  expect(s3WorkingSets(undefined, '')).toBeUndefined();
  // Silently keeping no working set would acknowledge every edit and persist none.
  expect(() => s3WorkingSets(undefined, 'collab')).toThrow('collab: an S3 working set needs an S3 bucket');
  expect(() => s3WorkingSets(new LocalStore('/tmp', 'http://localhost/files'), 'collab'))
    .toThrow('collab: an S3 working set needs an S3 bucket');
});

it('writes exactly what a restarted host reads back', async () => {
  const objects = fakeObjects();
  const key = `collab/${docKey('doc-s3')}`;

  objects.held.set(key, encodeDocument(tag, encodeFrames([update])));

  expect(await new S3WorkingSetStore(objects, 'collab').read('doc-s3')).toEqual({
    updates: encodeFrames([update]),
    tag,
  });
});
