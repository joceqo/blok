import { cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';
import { acquireJournalWriter, appendJournal, type AppendRequest, type JournalOptions } from './append.ts';
import { CHECKPOINT_MAGIC, readManifest, readSealed } from './files.ts';
import { inspectJournal, type JournalFrame } from './inspect.ts';
import type { OperationRecord } from './record.ts';
import { replayJournal } from './replay.ts';

const fixture = fileURLToPath(new URL('../../../test/fixtures/go-journal-rich', import.meta.url));
const lineage = '00112233445566778899aabbccddeeff';
/** The fixture is three committed operations and no checkpoint. */
const seeded = 3n;
const everyThree: JournalOptions = { checkpoint: { operations: 3n } };

function update(key: string, text: string): Uint8Array {
  const doc = new Doc();
  try { doc.getText(key).insert(0, text); return encodeStateAsUpdate(doc); }
  finally { doc.destroy(); }
}
/** Memoized: a resend must carry the same bytes, and every Doc mints its own client id. */
const requests = new Map<bigint, AppendRequest>();
function request(sequence: bigint): AppendRequest {
  let made = requests.get(sequence);
  if (!made) {
    made = { expectedLineage: lineage, expectedThrough: sequence - 1n, operationId: sequence.toString(16).padStart(32, '0'),
      actorId: 'node', source: 0, update: update('op' + sequence, 'v' + sequence) };
    requests.set(sequence, made);
  }
  return made;
}
/** Every committed operation names its own text, so a lost one is visible by name. */
function operations(state: Uint8Array): string[] {
  const doc = new Doc();
  try {
    applyUpdate(doc, state);
    return [...doc.share.keys()].filter((key) => key.startsWith('op')).sort();
  } finally { doc.destroy(); }
}
async function read(directory: string) {
  const frames: JournalFrame[] = [];
  const records: OperationRecord[] = [];
  const report = await inspectJournal(directory, (frame) => frames.push(frame), (record) => records.push(record));
  return { report, frames, records };
}
async function checkpointFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.startsWith('checkpoint.')).sort();
}

describe.skipIf(!['linux', 'darwin'].includes(process.platform))('publishing checkpoints', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blok-checkpoint-'));
    await cp(fixture, dir, { recursive: true });
  });
  afterEach(async () => { requests.clear(); await rm(dir, { recursive: true, force: true }); });

  /** Each call is its own writer lease, so a sequence of them is also a sequence of restarts. */
  async function commit(sequence: bigint, options?: JournalOptions) {
    return appendJournal(dir, request(sequence), options);
  }
  async function commitThrough(last: bigint, options?: JournalOptions) {
    for (let sequence = seeded + 1n; sequence <= last; sequence++) {
      expect(await commit(sequence, options)).toEqual({ outcome: 'committed', sequence });
    }
  }

  it('leaves the manifest alone while the tail stays under the threshold', async () => {
    await commitThrough(4n);
    expect((await readManifest(join(dir, 'manifest'), 'doc'))?.checkpointThrough).toBe(0n);
    expect(await checkpointFiles(dir)).toEqual([]);
  });

  it('shortens the replay without shortening the history', async () => {
    const before = await read(dir);
    expect(before.report.checkpoint).toBeNull();
    await commitThrough(9n, everyThree);

    const manifest = (await readManifest(join(dir, 'manifest'), 'doc'))!;
    expect(manifest.checkpointThrough).toBe(7n);
    expect(manifest.checkpointFence).toBe(manifest.fence);
    // Only the live checkpoint survives; the one published at 4 is superseded.
    expect(await checkpointFiles(dir)).toEqual(['checkpoint.1.7.1']);

    const after = await read(dir);
    // Replay is the checkpoint plus the two records past it, not eleven frames.
    expect(after.frames.map(({ source, sequence }) => [source, sequence]))
      .toEqual([['checkpoint', 7n], ['journal', 8n], ['journal', 9n]]);
    expect(before.frames.length).toBe(2 + Number(seeded));
    // S6: publishing removed no journalled operation.
    expect(after.report.journal?.durableThrough).toBe(9n);
    expect(after.records.map((record) => record.sequence)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
    // The compacted replay reproduces the state the full history describes.
    expect(operations(await replayJournal(dir))).toEqual(['op4', 'op5', 'op6', 'op7', 'op8', 'op9']);
  });

  it('keeps every operation id a checkpoint covers answerable from history', async () => {
    await commitThrough(9n, everyThree);
    expect((await readManifest(join(dir, 'manifest'), 'doc'))?.checkpointThrough).toBe(7n);

    // S6, while running and after a restart: a covered id answers its own sequence.
    for (const sequence of [4n, 5n, 6n, 7n]) {
      expect(await commit(sequence)).toEqual({ outcome: 'duplicate', sequence });
      expect(await commit(sequence)).toEqual({ outcome: 'duplicate', sequence });
    }
    // The same covered id with other bytes is still a conflict, not a fresh commit.
    const covered = { ...request(4n), update: update('op4', 'tampered') };
    expect(await appendJournal(dir, covered)).toEqual({ outcome: 'conflict', sequence: 4n });

    // An operation the fixture committed before this build ran is covered too.
    const first = (await read(dir)).records[0]!;
    expect(first.sequence).toBe(1n);
    expect(await appendJournal(dir, { expectedLineage: lineage, expectedThrough: 9n, operationId: first.operationId,
      actorId: first.actorId, source: first.source, update: first.update, digest: first.digest }))
      .toEqual({ outcome: 'duplicate', sequence: 1n });

    // Nothing above was recorded: the head is still the last real commit.
    expect((await read(dir)).report.journal?.durableThrough).toBe(9n);
  });

  it('replays the journal tail on top of a lagging checkpoint', async () => {
    await commitThrough(9n, everyThree);
    const { report } = await read(dir);
    expect(report.checkpoint!.through).toBeLessThan(report.journal!.durableThrough);

    // S5: the checkpoint alone has lost 8 and 9; the recovered document has not.
    const sealed = await readSealed(join(dir, report.checkpoint!.file), CHECKPOINT_MAGIC, 'doc');
    expect(operations(sealed.content)).toEqual(['op4', 'op5', 'op6', 'op7']);
    expect(operations(await replayJournal(dir))).toEqual(['op4', 'op5', 'op6', 'op7', 'op8', 'op9']);

    // And the restart accepts the next sequence rather than re-running the tail.
    expect(await commit(10n, everyThree)).toEqual({ outcome: 'committed', sequence: 10n });
  });

  it('falls back to the baseline and the whole journal when the checkpoint is unreadable', async () => {
    await commitThrough(9n, everyThree);
    const path = join(dir, 'checkpoint.1.7.1');
    const bytes = await readFile(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(path, bytes);

    // Strict inspection still calls it what it is.
    expect(await inspectJournal(dir)).toMatchObject({ integrity: 'corrupt', issue: expect.stringContaining('checksum') });
    // Recovery does not lose a document whose baseline and journal still describe it.
    expect(operations(await replayJournal(dir))).toEqual(['op4', 'op5', 'op6', 'op7', 'op8', 'op9']);
    expect(await commit(10n, everyThree)).toEqual({ outcome: 'committed', sequence: 10n });
    expect(await commit(4n)).toEqual({ outcome: 'duplicate', sequence: 4n });
  });

  it('publishes on the byte threshold as well as the operation count', async () => {
    await commitThrough(4n, { checkpoint: { operations: 1n << 40n, bytes: 1n } });
    expect((await readManifest(join(dir, 'manifest'), 'doc'))?.checkpointThrough).toBe(4n);
  });

  it('acknowledges the commit even when the checkpoint cannot be published', async () => {
    // A directory in the checkpoint's place fails the publication, not the append.
    await mkdir(join(dir, 'checkpoint.1.4.1'));
    expect(await commit(4n, everyThree)).toEqual({ outcome: 'committed', sequence: 4n });
    const manifest = (await readManifest(join(dir, 'manifest'), 'doc'))!;
    expect(manifest.checkpointThrough).toBe(0n);
    const { report, records } = await read(dir);
    expect(report.integrity).toBe('ok');
    expect(report.journal?.durableThrough).toBe(4n);
    expect(records.at(-1)?.sequence).toBe(4n);
  });

  it('recovers a room from the baseline when the checkpoint cannot be read back', async () => {
    await commitThrough(9n, everyThree);
    await unlink(join(dir, 'checkpoint.1.7.1'));

    const doc = new Doc();
    const seen: bigint[] = [];
    const writer = await acquireJournalWriter(dir);
    try {
      const { manifest, journal } = await writer.recover((frame) => applyUpdate(doc, frame.update), (r) => seen.push(r.sequence));
      // The manifest still names the checkpoint; the replay simply did not use it.
      expect(manifest.checkpointThrough).toBe(7n);
      expect(journal.durableThrough).toBe(9n);
      expect(seen).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
      expect(operations(encodeStateAsUpdate(doc))).toEqual(['op4', 'op5', 'op6', 'op7', 'op8', 'op9']);
    } finally {
      await writer.close();
      doc.destroy();
    }
  });

  it('survives a torn manifest slot by falling back to the previous head', async () => {
    await commitThrough(9n, everyThree);
    const path = join(dir, 'manifest');
    const manifest = await readFile(path);
    const live = (await readManifest(path, 'doc'))!;
    expect(live.checkpointThrough).toBe(7n);
    // Tear the slot the last publication wrote. The other one is the head before it,
    // and it names the checkpoint this publication's sweep already removed.
    manifest.fill(0, Number(live.writeCounter & 1n) * 128, Number(live.writeCounter & 1n) * 128 + 128);
    await writeFile(path, manifest);

    const older = (await readManifest(path, 'doc'))!;
    expect(older.writeCounter).toBe(live.writeCounter - 1n);
    expect(older.checkpointThrough).toBe(4n);
    expect(await checkpointFiles(dir)).toEqual(['checkpoint.1.7.1']);
    // Neither the lineage nor a single operation is lost by any of that.
    expect(operations(await replayJournal(dir))).toEqual(['op4', 'op5', 'op6', 'op7', 'op8', 'op9']);
    expect(await commit(10n)).toEqual({ outcome: 'committed', sequence: 10n });
    expect(await commit(4n)).toEqual({ outcome: 'duplicate', sequence: 4n });
  });
});
