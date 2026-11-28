import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHECKPOINT_MAGIC, InvalidDataError, MANIFEST_FILE_NAME, MANIFEST_SLOT_SIZE,
  checkpointName, encodeManifestSlot, readSealed, sealBytes, type JournalManifest,
} from './files.ts';

export interface CheckpointPolicy {
  /** Operations journalled past the published checkpoint before the next one is published. */
  operations: bigint;
  /** Journal bytes past the published checkpoint before the next one is published. */
  bytes: bigint;
}

/**
 * Go's room defaults (`CheckpointOperationThreshold` 64, `CheckpointByteThreshold`
 * 1 MiB), so a Node writer and a Go writer alternating on the same document
 * publish at the same cadence.
 *
 * A checkpoint costs one full-state encode and one fsynced file the size of the
 * document, so it is amortized over 64 appends; in exchange a replay applies at
 * most 64 updates on top of it instead of the whole lineage. The byte threshold
 * catches the other shape of the same cost: few operations carrying large
 * updates, where 64 of them would already be a long replay.
 */
export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = { operations: 64n, bytes: 1n << 20n };

const OPERATIONS_ENV = 'BLOK_COLLAB_CHECKPOINT_OPERATIONS';
const BYTES_ENV = 'BLOK_COLLAB_CHECKPOINT_BYTES';

function threshold(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new RangeError(`${name} must be a non-negative integer`);
  return BigInt(raw);
}

/** Explicit options win over the environment, which wins over the defaults. */
export function checkpointPolicy(overrides?: Partial<CheckpointPolicy>): CheckpointPolicy {
  return {
    operations: overrides?.operations ?? threshold(OPERATIONS_ENV, DEFAULT_CHECKPOINT_POLICY.operations),
    bytes: overrides?.bytes ?? threshold(BYTES_ENV, DEFAULT_CHECKPOINT_POLICY.bytes),
  };
}

/** A zero threshold is off; a checkpoint still needs at least one operation it would cover. */
export function checkpointDue(policy: CheckpointPolicy, operations: bigint, bytes: bigint): boolean {
  if (operations < 1n) return false;
  return (policy.operations > 0n && operations >= policy.operations) ||
    (policy.bytes > 0n && bytes >= policy.bytes);
}

/** Replace a file nothing references yet, without following any existing symlink. */
async function publishFile(path: string, data: Uint8Array) {
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

async function syncDirectory(path: string) {
  const dir = await open(path, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

/**
 * A superseded checkpoint is a whole document state on disk, so it is swept.
 * Only this fence's own names, only this generation, and only once the manifest
 * already names the replacement: superseded generations are history, and
 * another holder's fence may still be live.
 */
async function sweepSuperseded(root: string, generation: bigint, fence: bigint, live: string) {
  const pattern = new RegExp(`^checkpoint\\.${generation}\\.\\d+\\.${fence}$`);
  let removed = false;
  for (const name of await readdir(root)) {
    if (name === live || !pattern.test(name)) continue;
    await unlink(join(root, name));
    removed = true;
  }
  if (removed) await syncDirectory(root);
}

/**
 * Publish a checkpoint covering every operation through `through`, then name it
 * in the manifest.
 *
 * Nothing journalled is removed: a checkpoint compacts the **replay**, never the
 * **history**. The records it covers stay on disk, so their operation ids keep
 * answering their own original sequence (S6), and the operations committed after
 * it are replayed on top of it (S5).
 *
 * The order is what makes a crash survivable. The sealed file lands under a name
 * nothing references yet and is fsynced, then the directory entry is fsynced,
 * and only then does the manifest name it. A crash before the manifest write
 * leaves an unreferenced file and the previous checkpoint in force; a torn
 * manifest write leaves the other slot, which still carries the old head.
 */
export async function publishCheckpoint(
  root: string, manifest: JournalManifest, through: bigint, state: Uint8Array,
): Promise<JournalManifest> {
  if (through <= manifest.checkpointThrough) {
    throw new RangeError('A checkpoint must name a committed sequence above the published one');
  }
  // The writing fence is in the name, so a stalled holder cannot overwrite the
  // checkpoint a newer one published.
  const name = checkpointName(manifest.generation, through, manifest.fence);
  await publishFile(join(root, name), sealBytes(CHECKPOINT_MAGIC, through, state));
  await syncDirectory(root);

  const next: JournalManifest = {
    ...manifest,
    writeCounter: manifest.writeCounter + 1n,
    checkpointThrough: through,
    checkpointFence: manifest.fence,
  };
  const slot = encodeManifestSlot(next);
  const file = await open(join(root, MANIFEST_FILE_NAME), constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    // Write only the inactive checksummed slot. A torn write leaves the old head recoverable.
    const position = Number(next.writeCounter & 1n) * MANIFEST_SLOT_SIZE;
    let written = 0;
    while (written < slot.length) {
      const { bytesWritten } = await file.write(slot, written, slot.length - written, position + written);
      if (!bytesWritten) throw new Error('Truncated checkpoint publication');
      written += bytesWritten;
    }
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await sweepSuperseded(root, manifest.generation, manifest.fence, name);
  } catch (cause) {
    // The publication stands; the next one sweeps the same names again.
    console.warn(`Could not remove a superseded collaboration checkpoint: ${String(cause)}`);
  }
  return next;
}

/**
 * Whether the published checkpoint can still be read back. A checkpoint is
 * derived data that the baseline and the journal reproduce exactly, so a torn
 * one must cost replay time, not access to the document.
 */
export async function checkpointReadable(root: string, manifest: JournalManifest, documentId: string): Promise<boolean> {
  if (!manifest.seeded || manifest.checkpointThrough === 0n) return true;
  const name = checkpointName(manifest.generation, manifest.checkpointThrough, manifest.checkpointFence);
  try {
    const { tag } = await readSealed(join(root, name), CHECKPOINT_MAGIC, documentId);
    return tag === manifest.checkpointThrough;
  } catch (error) {
    if (error instanceof InvalidDataError) return false;
    throw error;
  }
}
