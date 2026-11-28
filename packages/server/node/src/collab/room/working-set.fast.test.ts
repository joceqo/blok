import { createHash } from 'node:crypto';
import { Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { expect, it, vi } from 'vitest';
import {
  CURRENT_FORMAT,
  decodeDocument,
  decodeOrAbsent,
  describeTag,
  docKey,
  encodeDocument,
  encodeFrames,
  ensureResetRaisesEpoch,
  ensureWriteDoesNotLowerEpoch,
  isLineage,
  newLineage,
  replayWorkingSet,
  type Tag,
} from './working-set.ts';

const lineage = 'f'.repeat(32);
const tag: Tag = { format: CURRENT_FORMAT, epoch: 19n, lineage };

const doc = new Doc();
doc.getMap('page').set('title', 'Earlier');
const first = encodeStateAsUpdate(doc);
const before = encodeStateVector(doc);
doc.getMap('page').set('title', 'Kept');
const second = encodeStateAsUpdate(doc, before);
doc.destroy();

it('names an object by the lower-hex SHA-256 of the doc id', () => {
  expect(docKey('doc-s3')).toBe(createHash('sha256').update('doc-s3', 'utf8').digest('hex'));
  expect(() => docKey('')).toThrow('collab: an empty doc id has no key');
});

it('mints a lineage the client can compare as a string', () => {
  const minted = newLineage();

  expect(isLineage(minted)).toBe(true);
  expect(minted).not.toBe(newLineage());
  for (const refused of ['', 'F'.repeat(32), 'f'.repeat(31), 'f'.repeat(33), 'g'.repeat(32)]) {
    expect(isLineage(refused)).toBe(false);
  }
});

it('round-trips the header and the frame section C# writes', () => {
  const frames = encodeFrames([first, second]);
  const document = encodeDocument(tag, frames);

  expect(document.subarray(0, 4).toString('latin1')).toBe('BKW2');
  expect(document.readInt32LE(4)).toBe(2);
  expect(document.readBigInt64LE(8)).toBe(19n);
  expect(document.subarray(16, 32).toString('hex')).toBe(lineage);
  expect(document.length).toBe(32 + 4 + first.length + 4 + second.length);

  const decoded = decodeDocument(document);

  expect(decoded.ok && decoded.set).toEqual({ updates: frames, tag });
});

it('refuses to encode a tag or a frame section it could never read back', () => {
  for (const refused of [
    { ...tag, format: 0 },
    { ...tag, epoch: -1n },
    { ...tag, lineage: 'not-a-lineage' },
  ]) {
    expect(() => encodeDocument(refused, Buffer.alloc(0)))
      .toThrow(`collab: the tag ${describeTag(refused)} is not encodable`);
  }
  expect(() => encodeFrames([new Uint8Array()])).toThrow('collab: update frames must not be empty');
  expect(() => encodeDocument(tag, Buffer.from([4, 0, 0, 0, 1])))
    .toThrow('collab: the frame section is not a valid update log');
});

it.each([
  ['the header is truncated', Buffer.alloc(31)],
  ['the magic bytes do not match', Buffer.concat([Buffer.from('BKWS'), Buffer.alloc(28)])],
  ['the tag (0, 0) is invalid', encodeDocument(tag, Buffer.alloc(0)).fill(0, 4, 16)],
  ['an update frame is empty or truncated', encodeDocument(tag, encodeFrames([first])).subarray(0, -1)],
])('reads back "%s" as unreadable', (message, document) => {
  const decoded = decodeDocument(document);

  expect(decoded.ok ? '' : decoded.message).toBe(message);
});

it('treats an unreadable stored blob as absent and says so once', () => {
  const log = vi.fn();

  expect(decodeOrAbsent('doc-s3', Buffer.alloc(31), log)).toBeUndefined();
  expect(log).toHaveBeenCalledWith(
    'collab: the working set for "doc-s3" is unreadable (the header is truncated); treating it as absent',
  );
  expect(decodeOrAbsent('doc-s3', encodeDocument(tag, Buffer.alloc(0)), log)?.tag).toEqual(tag);
  expect(log).toHaveBeenCalledTimes(1);
});

it('refuses a write that would lower the epoch and a reset that would not raise it', () => {
  const stored = { updates: Buffer.alloc(0), tag };

  expect(() => ensureWriteDoesNotLowerEpoch('doc-s3', stored, { ...tag, epoch: 18n }))
    .toThrow('collab: refusing to lower the working-set epoch for "doc-s3" from 19 to 18.');
  expect(() => ensureWriteDoesNotLowerEpoch('doc-s3', stored, tag)).not.toThrow();
  expect(() => ensureWriteDoesNotLowerEpoch('doc-s3', undefined, { ...tag, epoch: 0n })).not.toThrow();

  expect(() => ensureResetRaisesEpoch('doc-s3', stored, tag))
    .toThrow('collab: a reset must raise the working-set epoch for "doc-s3" above 19 (got 19).');
  expect(() => ensureResetRaisesEpoch('doc-s3', stored, { ...tag, epoch: 20n })).not.toThrow();
  expect(() => ensureResetRaisesEpoch('doc-s3', undefined, tag)).not.toThrow();
});

it('replays the frame section into the document the room left behind', () => {
  const replayed = replayWorkingSet(encodeFrames([first, second]));

  try {
    expect(replayed.getMap('page').get('title')).toBe('Kept');
  } finally {
    replayed.destroy();
  }
  // A frame whose dependency never arrived leaves Yjs holding pending structs:
  // projecting that would publish a document the room never had.
  expect(() => replayWorkingSet(encodeFrames([second]))).toThrow('collab: the working set is incomplete');
});
