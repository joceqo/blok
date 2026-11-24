import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { inspectJournal, type JournalFrame } from './inspect.ts';
import { decodeRecord, encodeRecord } from './record.ts';

const fixture = fileURLToPath(new URL('../../../test/fixtures/go-journal/', import.meta.url));
const copies: string[] = [];
async function copyJournal(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'blok-inspect-'));
  copies.push(directory); await cp(fixture, directory, { recursive: true });
  return directory;
}
afterEach(async () => { await Promise.all(copies.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function mutateManifest(directory: string, change: (slot: Buffer) => void): Promise<void> {
  const path = join(directory, 'manifest');
  const manifest = await readFile(path);
  for (const start of [0, 128]) {
    const slot = manifest.subarray(start, start + 128);
    change(slot); createHash('sha256').update(slot.subarray(0, 96)).digest().copy(slot, 96);
  }
  await writeFile(path, manifest);
}

it('inspects a stopped Go store, yields its checkpoint and suffix, and preserves every file', async () => {
  const directory = await copyJournal();
  await writeFile(join(directory, 'journal.100.99'), 'unrelated generation');
  const files = async () => Promise.all((await readdir(directory)).sort().map(async (name) => [name, await readFile(join(directory, name))]));
  const before = await files();
  const frames: JournalFrame[] = [];
  expect(await inspectJournal(directory, (frame) => frames.push(frame))).toMatchObject({
    integrity: 'ok', state: 'seeded',
    manifest: { epoch: 7n, generation: 1n, lineage: '00112233445566778899aabbccddeeff', checkpointThrough: 1n },
    baseline: { file: 'baseline.1.1', frames: 1 }, checkpoint: { file: 'checkpoint.1.1.1', through: 1n },
    journal: { file: 'journal.1.1', firstSequence: 1n, durableThrough: 3n, tailRecords: 2n, verifiedBytes: 501n },
  });
  expect(frames.map(({source, sequence}) => [source, sequence])).toEqual([['checkpoint', 1n], ['journal', 2n], ['journal', 3n]]);
  expect(await files()).toEqual(before);
});

it('uses the baseline and all operations when the manifest names no checkpoint', async () => {
  const directory = await copyJournal();
  await mutateManifest(directory, (slot) => slot.writeBigUInt64LE(0n, 60));
  const frames: JournalFrame[] = [];
  const result = await inspectJournal(directory, (frame) => frames.push(frame));
  expect(result.integrity).toBe('ok');
  expect(frames.map(({source, sequence}) => [source, sequence])).toEqual([['baseline', 0n], ['journal', 1n], ['journal', 2n], ['journal', 3n]]);
});

it('resolves names with fence values beyond Number precision', async () => {
  const directory = await copyJournal();
  const fence = (1n << 62n) + 17n;
  await mutateManifest(directory, (slot) => slot.writeBigUInt64LE(fence, 68));
  for (const stem of ['baseline', 'journal']) await rename(join(directory, stem + '.1.1'), join(directory, stem + '.1.' + fence));
  const result = await inspectJournal(directory);
  expect(result.integrity).toBe('ok'); expect(result.manifest?.generationFence).toBe(fence);
  expect(result.journal?.file).toBe('journal.1.' + fence);
});

it('reports an incomplete tail without truncation and preserves the verified prefix', async () => {
  const directory = await copyJournal();
  const path = join(directory, 'journal.1.1');
  const bytes = (await readFile(path)).subarray(0, -1);
  await writeFile(path, bytes);
  expect(await inspectJournal(directory)).toMatchObject({integrity: 'incomplete', journal: { durableThrough: 2n }});
  expect(await readFile(path)).toEqual(bytes);
});

it('reports checksum failures and the byte offset of the first bad record', async () => {
  const directory = await copyJournal();
  const path = join(directory, 'journal.1.1');
  const bytes = await readFile(path); bytes[0] = bytes[0]! ^ 1; await writeFile(path, bytes);
  expect(await inspectJournal(directory)).toMatchObject({integrity: 'corrupt', issue: expect.stringContaining('byte 0'), journal: {durableThrough: 0n}});
});

it.each(['gap', 'duplicate'])('rejects a valid encoded record with a %s', async (reason) => {
  const directory = await copyJournal();
  const path = join(directory, 'journal.1.1');
  const bytes = await readFile(path);
  const first = decodeRecord(bytes);
  if (first.status !== 'ok') throw new Error('Invalid test fixture');
  const next = encodeRecord({ ...first.record, sequence: reason === 'gap' ? 5n : 4n });
  await writeFile(path, Buffer.concat([bytes, next]));
  expect(await inspectJournal(directory)).toMatchObject({integrity: 'corrupt', journal: {durableThrough: 3n, verifiedBytes: 501n},
    issue: expect.stringContaining(reason === 'gap' ? 'expected sequence 4' : 'duplicate operation ID')});
});

it('rejects checkpoints beyond the last verified journal sequence', async () => {
  const directory = await copyJournal();
  await writeFile(join(directory, 'journal.1.1'), Buffer.alloc(0));
  expect(await inspectJournal(directory)).toMatchObject({integrity: 'corrupt', issue: expect.stringContaining('Checkpoint 1 exceeds')});
});

it('recognizes a purge marker and a journal whose manifest has disappeared', async () => {
  const directory = await copyJournal();
  await rm(join(directory, 'manifest'));
  expect(await inspectJournal(directory)).toMatchObject({integrity: 'corrupt', state: 'unknown', manifest: null});
  await writeFile(join(directory, 'purged'), '');
  expect(await inspectJournal(directory)).toMatchObject({integrity: 'ok', state: 'purged', journal: null});
});

it('propagates consumer errors instead of blaming disk integrity', async () => {
  const problem = new Error('cannot apply update');
  await expect(inspectJournal(fixture, () => { throw problem; })).rejects.toBe(problem);
});

it('treats a torn tail as corruption when the verified prefix cannot reach its checkpoint', async () => {
  const directory = await copyJournal();
  await writeFile(join(directory, 'journal.1.1'), Buffer.from([1]));
  expect(await inspectJournal(directory)).toMatchObject({integrity: 'corrupt', issue: expect.stringContaining('exceeds the verified prefix 0')});
});

it('classifies a missing referenced baseline and a missing journal consistently', async () => {
  for (const name of ['baseline.1.1', 'journal.1.1']) {
    const directory = await copyJournal();
    await rm(join(directory, name));
    expect(await inspectJournal(directory)).toMatchObject({integrity: 'missing', state: 'seeded', issue: expect.stringContaining(name)});
  }
});
