import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export const MANIFEST_FILE_NAME = 'manifest';
export const MANIFEST_MAGIC = 'BKJM';
export const BASELINE_MAGIC = 'BKJB';
export const CHECKPOINT_MAGIC = 'BKJC';

type SealedMagic = typeof BASELINE_MAGIC | typeof CHECKPOINT_MAGIC;

export const MANIFEST_SLOT_SIZE = 128;
const slotSize = MANIFEST_SLOT_SIZE;
const manifestSize = 2 * slotSize;
const slotContentSize = 96;
const manifestVersion = 2;
const sealedHeaderSize = 24;
const checksumSize = 32;

export class InvalidDataError extends Error {
  override name = 'InvalidDataError';
}

export interface JournalManifest {
  writeCounter: bigint;
  fence: bigint;
  generation: bigint;
  seeded: boolean;
  format: number;
  epoch: bigint;
  lineage: string;
  checkpointThrough: bigint;
  generationFence: bigint;
  checkpointFence: bigint;
}

export function journalName(generation: bigint, generationFence: bigint): string {
  return `journal.${generation}.${generationFence}`;
}

export function baselineName(generation: bigint, generationFence: bigint): string {
  return `baseline.${generation}.${generationFence}`;
}

export function checkpointName(generation: bigint, checkpointThrough: bigint, checkpointFence: bigint): string {
  return `checkpoint.${generation}.${checkpointThrough}.${checkpointFence}`;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function validChecksum(bytes: Buffer, contentSize: number): boolean {
  const actual = createHash('sha256').update(bytes.subarray(0, contentSize)).digest();
  return actual.equals(bytes.subarray(contentSize));
}

function decodeSlot(slot: Buffer): JournalManifest | number | undefined {
  if (!slot.subarray(0, 4).equals(Buffer.from(MANIFEST_MAGIC)) || !validChecksum(slot, slotContentSize)) return undefined;
  // Only a checksummed version byte is evidence of a foreign format.
  const version = slot.readUInt8(4);
  if (version !== manifestVersion) return version;
  return {
    writeCounter: slot.readBigUInt64LE(8),
    fence: slot.readBigUInt64LE(16),
    generation: slot.readBigUInt64LE(24),
    seeded: slot.readUInt8(5) === 1,
    format: slot.readInt32LE(32),
    epoch: slot.readBigInt64LE(36),
    lineage: slot.subarray(44, 60).toString('hex'),
    checkpointThrough: slot.readBigUInt64LE(60),
    generationFence: slot.readBigUInt64LE(68),
    checkpointFence: slot.readBigUInt64LE(76),
  };
}

/** One 128-byte slot: 96 bytes of fields, then their SHA-256. Mirrors Go's EncodeManifestSlot. */
export function encodeManifestSlot(manifest: JournalManifest): Buffer {
  if (!/^[0-9a-f]{32}$/.test(manifest.lineage)) throw new RangeError(`collab: lineage ${manifest.lineage} is not hex`);
  const slot = Buffer.alloc(slotSize);
  slot.write(MANIFEST_MAGIC);
  slot[4] = manifestVersion;
  slot[5] = manifest.seeded ? 1 : 0;
  slot.writeBigUInt64LE(manifest.writeCounter, 8);
  slot.writeBigUInt64LE(manifest.fence, 16);
  slot.writeBigUInt64LE(manifest.generation, 24);
  slot.writeInt32LE(manifest.format, 32);
  slot.writeBigInt64LE(manifest.epoch, 36);
  slot.write(manifest.lineage, 44, 16, 'hex');
  slot.writeBigUInt64LE(manifest.checkpointThrough, 60);
  slot.writeBigUInt64LE(manifest.generationFence, 68);
  slot.writeBigUInt64LE(manifest.checkpointFence, 76);
  createHash('sha256').update(slot.subarray(0, slotContentSize)).digest().copy(slot, slotContentSize);
  return slot;
}

/** Seal a baseline or checkpoint: magic, version, tag, length, content, then a SHA-256 over all of it. */
export function sealBytes(magic: SealedMagic, tag: bigint, content: Uint8Array): Buffer {
  const header = Buffer.alloc(sealedHeaderSize);
  header.write(magic);
  header[4] = 1;
  header.writeBigUInt64LE(tag, 8);
  header.writeBigUInt64LE(BigInt(content.length), 16);
  const sealed = Buffer.concat([header, content]);
  return Buffer.concat([sealed, createHash('sha256').update(sealed).digest()]);
}

/** Read a stopped journal or a consistent offline copy. Node does not acquire the live writer's flock. */
export async function readManifest(path: string, documentId: string): Promise<JournalManifest | null> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  let bytes: Buffer;
  try {
    const { size } = await file.stat({ bigint: true });
    if (size === 0n) return null;
    if (size !== BigInt(manifestSize)) {
      throw new InvalidDataError(`collab: the manifest for "${documentId}" is ${size} bytes, not ${manifestSize}.`);
    }
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  if (bytes.length !== manifestSize) {
    throw new InvalidDataError(`collab: the manifest for "${documentId}" is ${bytes.length} bytes, not ${manifestSize}.`);
  }
  let best: JournalManifest | null = null;
  let foreignVersion: number | undefined;
  for (let offset = 0; offset < bytes.length; offset += slotSize) {
    const candidate = decodeSlot(bytes.subarray(offset, offset + slotSize));
    if (typeof candidate === 'number') foreignVersion = candidate;
    else if (candidate && (!best || candidate.writeCounter > best.writeCounter)) best = candidate;
  }
  if (best) return best;
  if (foreignVersion !== undefined) {
    throw new InvalidDataError(`collab: the manifest for "${documentId}" is version ${foreignVersion}, and this build writes version ${manifestVersion}.`);
  }
  throw new InvalidDataError(`collab: neither manifest slot for "${documentId}" decodes.`);
}

/** Verify a baseline or checkpoint on an offline copy before returning its opaque content. */
export async function readSealed(path: string, magic: SealedMagic, documentId: string): Promise<{ content: Buffer; tag: bigint }> {
  const name = basename(path);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (missing(error)) {
      throw new InvalidDataError(`collab: "${documentId}" names ${name}, which is not there.`, { cause: error });
    }
    throw error;
  }
  if (bytes.length < sealedHeaderSize + checksumSize || !bytes.subarray(0, 4).equals(Buffer.from(magic)) || bytes[4] !== 1) {
    throw new InvalidDataError(`collab: ${name} for "${documentId}" is not a readable record.`);
  }
  const length = bytes.readBigInt64LE(16);
  const checksumOffset = bytes.length - checksumSize;
  if (length !== BigInt(checksumOffset - sealedHeaderSize)) {
    throw new InvalidDataError(`collab: ${name} for "${documentId}" declares ${length} content bytes, which is not what it holds.`);
  }
  if (!validChecksum(bytes, checksumOffset)) {
    throw new InvalidDataError(`collab: ${name} for "${documentId}" fails its checksum.`);
  }
  return { tag: bytes.readBigUInt64LE(8), content: bytes.subarray(sealedHeaderSize, checksumOffset) };
}
