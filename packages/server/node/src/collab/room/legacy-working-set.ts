import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { applyUpdate, Doc } from 'yjs';
import { envelope, exportPage, type Snapshot } from './page-document.ts';

type Remote = { data: Snapshot; lineage: string | null; sequence: string | null };
export interface Baseline {
  frames: Buffer;
  epoch: bigint;
  lineage: Buffer;
}

async function identity(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// The old Go LocalStore atomically renames a new inode into place. Verify both
// its identity and timestamps immediately before publishing the new directory.
function same(before?: BigIntStats, after?: BigIntStats) {
  return (
    before?.dev === after?.dev &&
    before?.ino === after?.ino &&
    before?.size === after?.size &&
    before?.ctimeNs === after?.ctimeNs &&
    before?.mtimeNs === after?.mtimeNs
  );
}

export async function readWorkingSet(path: string, remote: Remote) {
  const before = await identity(path);
  async function unchanged() {
    if (!same(before, await identity(path))) throw new Error('Go working set changed during handoff');
  }
  if (!before) return { baseline: undefined, unchanged };
  if (!before.isFile()) throw new Error('Expected a regular Go working-set file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    if (!same(before, await file.stat({ bigint: true })))
      throw new Error('Go working set changed during handoff');
    bytes = await file.readFile();
    await unchanged();
  } finally {
    await file.close();
  }

  if (bytes.length < 32 || !bytes.subarray(0, 4).equals(Buffer.from('BKW2')))
    throw new Error('Unreadable Go working-set header');
  const format = bytes.readInt32LE(4);
  const epoch = bytes.readBigInt64LE(8);
  if (format !== 2 || epoch < 0n || epoch > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Unsupported Go working-set format or epoch');
  const lineage = bytes.subarray(16, 32);
  if (remote.lineage !== null && (remote.lineage !== lineage.toString('hex') || remote.sequence !== '0'))
    throw new Error('Go working-set lineage or sequence conflicts with the projection');

  const frames = bytes.subarray(32);
  const doc = new Doc();
  try {
    for (let offset = 0; offset < frames.length; ) {
      if (frames.length - offset < 4) throw new Error('Truncated Go working-set frame length');
      const size = frames.readInt32LE(offset);
      offset += 4;
      if (size <= 0 || size > frames.length - offset) throw new Error('Invalid Go working-set frame length');
      applyUpdate(doc, frames.subarray(offset, offset + size));
      offset += size;
    }
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null)
      throw new Error('Incomplete Yjs state in Go working set');
    if (!isDeepStrictEqual(exportPage(doc, envelope(remote.data)), remote.data ?? { blocks: [] }))
      throw new Error('Go working set and canonical projection have different content');
  } finally {
    doc.destroy();
  }
  return { baseline: { frames, epoch, lineage }, unchanged };
}
