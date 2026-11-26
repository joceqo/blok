// A document's persisted Yjs update log for a room with no journal. The bytes
// are the ones C# writes (CollabWorkingSetCodec.cs, CollabWorkingSetLaw.cs) and
// Go reads (internal/collab/workingset): one header, then length-prefixed frames.
import { createHash, randomBytes } from 'node:crypto';
import { applyUpdate, Doc } from 'yjs';

/** "BKW2", int32 format, int64 epoch, then 16 lineage bytes. */
export const HEADER_LENGTH = 32;

/** Rich text as formatted Y.XmlText: the only format this server writes. */
export const CURRENT_FORMAT = 2;

/** The lineage length in hex characters. */
export const LINEAGE_LENGTH = 32;

const FRAME_PREFIX_LENGTH = 4;
const LINEAGE_OFFSET = 16;
// "BKWS" was the pre-lineage header; it now reads as unreadable. It never shipped.
const MAGIC = Buffer.from('BKW2');

/** The schema format, the reset count and the history id. */
export interface Tag {
  format: number;
  epoch: bigint;
  lineage: string;
}

export interface WorkingSet {
  updates: Buffer;
  tag: Tag;
}

export type Decoded = { ok: true; set: WorkingSet } | { ok: false; message: string };

/** Names every object and every file: the lower-hex SHA-256 of the UTF-8 doc id. */
export function docKey(docId: string): string {
  if (docId === '') throw new Error('collab: an empty doc id has no key');
  return createHash('sha256').update(docId, 'utf8').digest('hex');
}

export function newLineage(): string {
  return randomBytes(LINEAGE_LENGTH / 2).toString('hex');
}

/** The client compares lineages as strings, so only lower hex is one. */
export function isLineage(value: string): boolean {
  return value.length === LINEAGE_LENGTH && /^[0-9a-f]+$/.test(value);
}

/** A tag that may be persisted or sent to a client. */
export function isAnnounceable(tag: Tag): boolean {
  return tag.format >= 1 && tag.epoch >= 0n && isLineage(tag.lineage);
}

/** The C# record's ToString, which the refusal messages carry. */
export function describeTag(tag: Tag): string {
  return `CollabWorkingSetTag { Format = ${tag.format}, Epoch = ${tag.epoch}, Lineage = ${tag.lineage} }`;
}

export function encodeFrames(updates: readonly Uint8Array[]): Buffer {
  for (const update of updates) {
    if (update.length === 0) throw new Error('collab: update frames must not be empty');
  }
  return Buffer.concat(updates.map((update) => {
    const frame = Buffer.alloc(FRAME_PREFIX_LENGTH + update.length);
    frame.writeInt32LE(update.length);
    frame.set(update, FRAME_PREFIX_LENGTH);
    return frame;
  }));
}

function walkFrames(section: Buffer, collect: boolean): Uint8Array[] | undefined {
  const updates: Uint8Array[] = [];
  for (let offset = 0; offset < section.length;) {
    if (section.length - offset < FRAME_PREFIX_LENGTH) return undefined;
    const length = section.readInt32LE(offset);
    offset += FRAME_PREFIX_LENGTH;
    if (length < 1 || length > section.length - offset) return undefined;
    if (collect) updates.push(Buffer.from(section.subarray(offset, offset + length)));
    offset += length;
  }
  return updates;
}

export function validateFrames(section: Buffer): boolean {
  return walkFrames(section, false) !== undefined;
}

export function decodeFrames(section: Buffer): Uint8Array[] | undefined {
  return walkFrames(section, true);
}

export function encodeDocument(tag: Tag, frameSection: Buffer): Buffer {
  if (!isAnnounceable(tag)) throw new Error(`collab: the tag ${describeTag(tag)} is not encodable`);
  if (!validateFrames(frameSection)) throw new Error('collab: the frame section is not a valid update log');
  const document = Buffer.alloc(HEADER_LENGTH + frameSection.length);
  MAGIC.copy(document);
  document.writeInt32LE(tag.format, 4);
  document.writeBigInt64LE(tag.epoch, 8);
  document.set(Buffer.from(tag.lineage, 'hex'), LINEAGE_OFFSET);
  document.set(frameSection, HEADER_LENGTH);
  return document;
}

export function decodeHeader(header: Buffer): { ok: true; tag: Tag } | { ok: false; message: string } {
  if (header.length < HEADER_LENGTH) return { ok: false, message: 'the header is truncated' };
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) return { ok: false, message: 'the magic bytes do not match' };
  const format = header.readInt32LE(4);
  const epoch = header.readBigInt64LE(8);
  if (format < 1 || epoch < 0n) return { ok: false, message: `the tag (${format}, ${epoch}) is invalid` };
  return { ok: true, tag: { format, epoch, lineage: header.subarray(LINEAGE_OFFSET, HEADER_LENGTH).toString('hex') } };
}

export function decodeDocument(document: Buffer): Decoded {
  const header = decodeHeader(document);
  if (!header.ok) return header;
  const updates = document.subarray(HEADER_LENGTH);
  if (!validateFrames(updates)) return { ok: false, message: 'an update frame is empty or truncated' };
  return { ok: true, set: { updates: Buffer.from(updates), tag: header.tag } };
}

/** An unreadable blob is logged and read as absent: it may be the only copy left to repair from. */
export function decodeOrAbsent(docId: string, document: Buffer, log?: (message: string) => void): WorkingSet | undefined {
  const decoded = decodeDocument(document);
  if (decoded.ok) return decoded.set;
  log?.(`collab: the working set for "${docId}" is unreadable (${decoded.message}); treating it as absent`);
  return undefined;
}

export function ensureWriteDoesNotLowerEpoch(docId: string, stored: WorkingSet | undefined, next: Tag): void {
  if (stored !== undefined && next.epoch < stored.tag.epoch) {
    throw new Error(
      `collab: refusing to lower the working-set epoch for "${docId}" from ${stored.tag.epoch} to ${next.epoch}.`,
    );
  }
}

export function ensureResetRaisesEpoch(docId: string, stored: WorkingSet | undefined, next: Tag): void {
  if (stored !== undefined && next.epoch <= stored.tag.epoch) {
    throw new Error(
      `collab: a reset must raise the working-set epoch for "${docId}" above ${stored.tag.epoch} (got ${next.epoch}).`,
    );
  }
}

/**
 * Rebuilds the document the room left behind. Yjs holds a frame whose
 * dependency never arrived instead of failing, so a pending store means the
 * log is short of an update and projecting it would publish a state the room
 * never had.
 */
export function replayWorkingSet(updates: Buffer): Doc {
  const frames = decodeFrames(updates);
  if (frames === undefined) throw new Error('collab: an update frame is empty or truncated');
  const doc = new Doc();
  try {
    for (const frame of frames) applyUpdate(doc, frame);
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
      throw new Error('collab: the working set is incomplete');
    }
  } catch (error) {
    doc.destroy();
    throw error;
  }
  return doc;
}
