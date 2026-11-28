import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { acquireJournalLock, assertNotPurged } from '../journal/append.ts';
import { baselineName, journalName, readManifest } from '../journal/files.ts';
import { historyLineages, recordHistoryLineage } from './history-lineages.ts';
import { syncDirectory } from './page-seed.ts';

/** Replace a private/unused generation file without following any existing symlink. */
export async function publishFile(path: string, data: Uint8Array | string) {
  const temporary = path + '.' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Publish a fresh format-2 baseline, retaining the preceding lineage for history. */
export async function resetGeneration(
  directory: string,
  prepare: (lineage: string) => Promise<Uint8Array>,
  finish: () => Promise<void>,
) {
  const lease = await acquireJournalLock(directory);
  try {
    await assertNotPurged(directory);
    const path = join(directory, 'manifest');
    const prior = await readManifest(path, basename(directory));
    if (!prior?.seeded) throw new Error('Missing journal lineage');
    if (prior.epoch >= BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Document epoch exhausted');
    const lineage = randomBytes(16).toString('hex');
    const update = await prepare(lineage);
    const next = {
      ...prior,
      lineage,
      epoch: prior.epoch + 1n,
      format: 2,
      writeCounter: prior.writeCounter + 1n,
      generation: prior.generation + 1n,
      generationFence: prior.fence,
      checkpointFence: 0n,
      checkpointThrough: 0n,
    };
    const bytes = Buffer.alloc(28 + update.length);
    bytes.write('BKJB');
    bytes[4] = 1;
    bytes.writeBigInt64LE(BigInt(update.length + 4), 16);
    bytes.writeUInt32LE(update.length, 24);
    bytes.set(update, 28);
    await publishFile(
      join(directory, baselineName(next.generation, next.generationFence)),
      Buffer.concat([bytes, createHash('sha256').update(bytes).digest()]),
    );
    await publishFile(join(directory, journalName(next.generation, next.generationFence)), Buffer.alloc(0));
    const current = (await historyLineages(directory)).find((entry) => entry.current)!;
    await recordHistoryLineage(directory, prior, current.createdAt);
    await syncDirectory(directory);
    const slot = Buffer.alloc(128);
    slot.write('BKJM');
    slot[4] = 2;
    slot[5] = 1;
    slot.writeBigUInt64LE(next.writeCounter, 8);
    slot.writeBigUInt64LE(next.fence, 16);
    slot.writeBigUInt64LE(next.generation, 24);
    slot.writeInt32LE(next.format, 32);
    slot.writeBigInt64LE(next.epoch, 36);
    slot.set(Buffer.from(lineage, 'hex'), 44);
    slot.writeBigUInt64LE(next.generationFence, 68);
    slot.set(createHash('sha256').update(slot.subarray(0, 96)).digest(), 96);
    const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      // Write only the inactive checksummed slot. A torn write leaves the old head recoverable.
      const position = Number(next.writeCounter & 1n) * 128;
      let n = 0;
      while (n < slot.length) {
        const { bytesWritten } = await file.write(slot, n, slot.length - n, position + n);
        if (!bytesWritten) throw new Error('Truncated reset publication');
        n += bytesWritten;
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await recordHistoryLineage(directory, next, Date.now());
    await syncDirectory(directory);
    await finish();
  } finally {
    await lease.close();
  }
}
