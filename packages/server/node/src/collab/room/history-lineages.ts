import { createHash } from 'node:crypto';
import { open, readFile, readdir, rm } from 'node:fs/promises';
import { notesFilename } from './record-notes.ts';
import { syncDirectory } from './page-seed.ts';
import { basename, join } from 'node:path';
import {
  readManifest,
  baselineName,
  journalName,
  type JournalManifest,
  MANIFEST_FILE_NAME,
} from '../journal/files.ts';

export interface HistoryLineage {
  manifest: JournalManifest;
  current: boolean;
  createdAt: number | null;
}

/** Older generations are named by this checksummed ledger, not by directory enumeration. */
export async function historyLineages(directory: string) {
  const live = await readManifest(join(directory, MANIFEST_FILE_NAME), basename(directory));
  if (!live?.seeded) throw new Error('Missing live lineage');
  let bytes: Buffer;
  try {
    bytes = await readFile(join(directory, 'lineages'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    bytes = Buffer.alloc(0);
  }
  const newest = new Map<string, HistoryLineage>();
  const deleted = new Set<string>();
  for (let start = 0; start + 61 <= bytes.length; start += 61) {
    const entry = bytes.subarray(start, start + 61);
    const hash = createHash('sha256').update(entry.subarray(0, 53)).digest().subarray(0, 8);
    if (!hash.equals(entry.subarray(53))) continue;
    const generation = entry.readBigUInt64LE(1),
      generationFence = entry.readBigUInt64LE(9);
    const key = generation + ':' + generationFence;
    if (entry[0] === 2) {
      deleted.add(key);
      continue;
    }
    if (entry[0] !== 1 || !generation) continue;
    const lineage = entry.subarray(17, 33).toString('hex');
    const ticks = entry.readBigInt64LE(45);
    if (ticks !== -(1n << 63n) && (ticks < 0n || ticks > 3155378975999999999n)) continue;
    if ((newest.get(lineage)?.manifest.generation ?? 0n) > generation) continue;
    const current = generation === live.generation && generationFence === live.generationFence;
    const manifest = current
      ? live
      : {
          ...live,
          generation,
          generationFence,
          lineage,
          epoch: entry.readBigInt64LE(33),
          format: entry.readInt32LE(41),
          checkpointThrough: 0n,
        };
    newest.set(lineage, {
      manifest,
      current,
      createdAt: ticks === -(1n << 63n) ? null : Number((ticks - 621355968000000000n) / 10000n),
    });
  }
  const actual = newest.get(live.lineage);
  if (!actual?.current) newest.set(live.lineage, { manifest: live, current: true, createdAt: null });
  return [...newest.values()]
    .filter((e) => !deleted.has(e.manifest.generation + ':' + e.manifest.generationFence))
    .sort((a, b) =>
      a.manifest.generation > b.manifest.generation
        ? -1
        : a.manifest.generation < b.manifest.generation
          ? 1
          : 0,
    );
}

/** Append only while holding the document lease. */
export async function recordHistoryLineage(directory:string,manifest:JournalManifest,createdAt:number|null,type:1|2=1) {
  const size = 61,
    slot = Buffer.alloc(size);
  slot[0] = type;
  slot.writeBigUInt64LE(manifest.generation, 1);
  slot.writeBigUInt64LE(manifest.generationFence, 9);
  Buffer.from(manifest.lineage, 'hex').copy(slot, 17);
  slot.writeBigInt64LE(manifest.epoch, 33);
  slot.writeInt32LE(manifest.format, 41);
  slot.writeBigInt64LE(
    createdAt === null ? -(1n << 63n) : 621355968000000000n + BigInt(createdAt) * 10000n,
    45,
  );
  createHash('sha256').update(slot.subarray(0, 53)).digest().copy(slot, 53, 0, 8);
  const file = await open(join(directory, 'lineages'), 'a+', 0o600);
  try {
    const stat = await file.stat();
    const offset = stat.size - (stat.size % size);
    if (stat.size !== offset) await file.truncate(offset);
    let done = 0;
    while (done < size) {
      const result = await file.write(slot, done, size - done, offset + done);
      if (!result.bytesWritten) throw new Error('Lineage tombstone write failed');
      done += result.bytesWritten;
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function deleteArchivedLineage(directory: string, entry: HistoryLineage, live: HistoryLineage) {
  const { manifest } = entry;
  if (entry.current || manifest.generation === live.manifest.generation) return false;
  await recordHistoryLineage(directory,manifest,entry.createdAt,2);
  const oldChecks = (await readdir(directory)).filter((name) =>
    name.startsWith('checkpoint.' + manifest.generation + '.'),
  );
  for (const name of [
    baselineName(manifest.generation, manifest.generationFence),
    journalName(manifest.generation, manifest.generationFence),
    notesFilename(manifest.lineage),
    ...oldChecks,
  ])
    await rm(join(directory, name), { force: true });
  await syncDirectory(directory);
  return true;
}
