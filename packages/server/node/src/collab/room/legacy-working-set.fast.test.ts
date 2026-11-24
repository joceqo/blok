import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readWorkingSet } from './legacy-working-set.ts';
import { pageDirectory } from './page-seed.ts';
import { preparePageStorage } from './page-storage.ts';

let root: string;
const id = 'archived-page';
const secret = 's'.repeat(32);
const lineage = 'f'.repeat(32);
const snapshot = { title: 'Legacy', blocks: [] };
const key = () => pageDirectory(root, id).slice(0, -'.journal'.length);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'legacy-room-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function legacy(frames: Uint8Array[], format = 2, epoch = 19n) {
  const header = Buffer.alloc(32);
  header.write('BKW2');
  header.writeInt32LE(format, 4);
  header.writeBigInt64LE(epoch, 8);
  Buffer.from(lineage, 'hex').copy(header, 16);
  return Buffer.concat([
    header,
    ...frames.map((frame) => {
      const packed = Buffer.alloc(4 + frame.length);
      packed.writeInt32LE(frame.length);
      packed.set(frame, 4);
      return packed;
    }),
  ]);
}
const doc = new Doc();
doc.getMap('page').set('title', 'Earlier');
const first = encodeStateAsUpdate(doc),
  before = encodeStateVector(doc);
doc.getMap('page').set('title', 'Legacy');
const second = encodeStateAsUpdate(doc, before);
doc.destroy();

it.each([
  ['bad header', Buffer.from('BKW1'), snapshot, null, null],
  ['old editor format', legacy([first, second], 1), snapshot, null, null],
  ['unsafe epoch', legacy([first, second], 2, 1n << 53n), snapshot, null, null],
  ['truncated frame', legacy([first, second]).subarray(0, -1), snapshot, null, null],
  ['unresolved Yjs reference', legacy([second]), snapshot, null, null],
  ['content conflict', legacy([first, second]), { title: 'External', blocks: [] }, null, null],
  ['foreign lineage', legacy([first, second]), snapshot, '0'.repeat(32), '0'],
  ['database already ahead', legacy([first, second]), snapshot, lineage, '1'],
] as const)(
  'refuses %s before publishing files or updating the product',
  async (_name, source, data, dbLineage, sequence) => {
    await writeFile(key(), source);
    const fetch = vi.fn(async () => Response.json({ data, version: '3', lineage: dbLineage, sequence }));
    vi.stubGlobal('fetch', fetch);
    await expect(preparePageStorage(root, id, 'http://localhost', secret)).rejects.toThrow();
    expect(await readFile(key())).toEqual(source);
    await expect(readFile(join(pageDirectory(root, id), 'manifest'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('detects an atomic source replacement between validation and publication', async () => {
  const source = legacy([first, second]);
  await writeFile(key(), source);
  const imported = await readWorkingSet(key(), { data: snapshot, lineage: null, sequence: null });
  await imported.unchanged();
  await writeFile(key() + '.next', source);
  await rename(key() + '.next', key());
  await expect(imported.unchanged()).rejects.toThrow(/changed during handoff/);
});
