import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

export type OperationSource = 0 | 1 | 2; // ClientV2, ClientV1, HttpEdit
export interface OperationRecord {
  operationId: string;
  sequence: bigint;
  /** UTC ticks (100 ns since 0001-01-01), including sub-millisecond precision. */
  committedAtTicks: bigint;
  actorId: string | null;
  source: OperationSource;
  update: Uint8Array;
  digest: Uint8Array;
}

export type DecodeResult =
  | { status: 'ok'; record: OperationRecord; bytesRead: number; nextOffset: number }
  | { status: 'incomplete' | 'corrupt'; message: string; bytesRead: 0; nextOffset: number };

const DIGEST_BYTES = 32;
const HEADER_CONTENT_BYTES = 6;
export const RECORD_HEADER_BYTES = HEADER_CONTENT_BYTES + DIGEST_BYTES;
const FIXED_BODY_BYTES = 16 + 8 + 8 + 4 + DIGEST_BYTES + 4;
const MAX_ACTOR_BYTES = 4096;
const MAX_UPDATE_BYTES = 32 * 1024 * 1024;
const MIN_BODY_BYTES = FIXED_BODY_BYTES + 1 + DIGEST_BYTES;
const MAX_BODY_BYTES = FIXED_BODY_BYTES + MAX_ACTOR_BYTES + MAX_UPDATE_BYTES + DIGEST_BYTES;
export const MAX_RECORD_BYTES = RECORD_HEADER_BYTES + MAX_BODY_BYTES;

const VERSION = 1;
const MAX_TICKS = 3155378975999999999n;
const MAX_SEQUENCE = (1n << 64n) - 1n;

function checksum(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

function definedSource(value: number): value is OperationSource {
  return value === 0 || value === 1 || value === 2;
}

/** Read one Go/.NET journal record. Torn and corrupt records consume no bytes. */
export function decodeRecord(input: Uint8Array, offset = 0): DecodeResult {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > input.length) throw new RangeError('Invalid journal offset');
  const incomplete = (): DecodeResult => ({ status: 'incomplete', message: '', bytesRead: 0, nextOffset: offset });
  const corrupt = (message: string): DecodeResult => ({ status: 'corrupt', message, bytesRead: 0, nextOffset: offset });
  if (input.length - offset < RECORD_HEADER_BYTES) return incomplete();

  const bytes = Buffer.from(input.buffer, input.byteOffset + offset, input.length - offset);
  const headerHash = checksum(bytes.subarray(0, HEADER_CONTENT_BYTES));
  if (!headerHash.equals(bytes.subarray(HEADER_CONTENT_BYTES, RECORD_HEADER_BYTES))) {
    return corrupt('the header checksum does not match its content');
  }
  if (bytes[4] !== VERSION) return corrupt(`unsupported codec version ${bytes[4]}`);
  const source = bytes[5]!;
  if (!definedSource(source)) return corrupt(`unknown operation source ${source}`);
  const bodyLength = bytes.readInt32LE(0);
  if (bodyLength < MIN_BODY_BYTES || bodyLength > MAX_BODY_BYTES) return corrupt(`the body length ${bodyLength} is out of range`);
  const bytesRead = RECORD_HEADER_BYTES + bodyLength;
  if (bytes.length < bytesRead) return incomplete();
  const content = bytes.subarray(RECORD_HEADER_BYTES, bytesRead - DIGEST_BYTES);
  if (!checksum(content).equals(bytes.subarray(bytesRead - DIGEST_BYTES, bytesRead))) {
    return corrupt('the body checksum does not match its content');
  }

  const operationId = content.toString('hex', 0, 16);
  const sequence = content.readBigUInt64LE(16);
  if (sequence === 0n) return corrupt('server sequence 0 means nothing was committed on this lineage');
  const committedAtTicks = content.readBigInt64LE(24);
  if (committedAtTicks < 0n || committedAtTicks > MAX_TICKS) return corrupt('committedAt is out of range');
  const actorLength = content.readInt32LE(32);
  let cursor = 36;
  if (actorLength < -1 || actorLength > MAX_ACTOR_BYTES || actorLength > content.length - cursor) {
    return corrupt('the actor id length is invalid');
  }
  let actorId = null;
  if (actorLength >= 0) {
    const actor = content.subarray(cursor, cursor + actorLength);
    if (!isUtf8(actor)) return corrupt('the actor id is not valid UTF-8');
    actorId = actor.toString('utf8');
    cursor += actorLength;
  }
  if (content.length - cursor < DIGEST_BYTES) return corrupt('the digest is truncated');
  const digest = content.subarray(cursor, cursor + DIGEST_BYTES);
  cursor += DIGEST_BYTES;
  if (content.length - cursor < 4) return corrupt('the update length is missing');
  const updateLength = content.readInt32LE(cursor);
  cursor += 4;
  if (updateLength < 1 || updateLength > MAX_UPDATE_BYTES || updateLength > content.length - cursor) {
    return corrupt('the update length is invalid');
  }
  const trailing = content.length - cursor - updateLength;
  if (trailing !== 0) return corrupt(`${trailing} trailing byte(s) inside the record body`);

  // Give the caller independent bytes even when a streaming reader reuses input.
  const record = { operationId, sequence, committedAtTicks, actorId, source,
    digest: Uint8Array.from(digest), update: Uint8Array.from(content.subarray(cursor)) };
  return { status: 'ok', record, bytesRead, nextOffset: offset + bytesRead };
}

/** Produce a single record in the canonical little-endian disk format. */
export function encodeRecord(record: OperationRecord): Uint8Array {
  if (record.operationId.length !== 32 || !/^[0-9a-f]{32}$/.test(record.operationId)) {
    throw new RangeError('The operation ID must be 32 lowercase hex characters');
  }
  if (typeof record.sequence !== 'bigint' || record.sequence < 1n || record.sequence > MAX_SEQUENCE) throw new RangeError('Invalid journal sequence');
  if (typeof record.committedAtTicks !== 'bigint' || record.committedAtTicks < 0n || record.committedAtTicks > MAX_TICKS) throw new RangeError('Invalid committedAt ticks');
  if (!definedSource(record.source)) throw new RangeError('Unknown operation source');
  if (record.digest.length !== DIGEST_BYTES) throw new RangeError('Invalid digest size');
  if (record.update.length < 1 || record.update.length > MAX_UPDATE_BYTES) throw new RangeError('Invalid update size');
  let actor: Buffer | undefined;
  if (record.actorId !== null) {
    if (Buffer.byteLength(record.actorId) > MAX_ACTOR_BYTES) throw new RangeError('Actor ID too long');
    actor = Buffer.from(record.actorId, 'utf8');
    if (actor.toString('utf8') !== record.actorId) throw new RangeError('Invalid actor ID Unicode');
  }
  const bodyLength = FIXED_BODY_BYTES + (actor?.length ?? 0) + record.update.length + DIGEST_BYTES;
  const bytes = Buffer.alloc(RECORD_HEADER_BYTES + bodyLength);
  bytes.writeInt32LE(bodyLength, 0);
  bytes[4] = VERSION;
  bytes[5] = record.source;
  bytes.set(checksum(bytes.subarray(0, HEADER_CONTENT_BYTES)), HEADER_CONTENT_BYTES);

  const body = bytes.subarray(RECORD_HEADER_BYTES);
  body.write(record.operationId, 0, 16, 'hex');
  body.writeBigUInt64LE(record.sequence, 16);
  body.writeBigInt64LE(record.committedAtTicks, 24);
  body.writeInt32LE(actor?.length ?? -1, 32);
  let cursor = 36;
  if (actor) cursor += actor.copy(body, cursor);
  body.set(record.digest, cursor);
  cursor += DIGEST_BYTES;
  body.writeInt32LE(record.update.length, cursor);
  cursor += 4;
  body.set(record.update, cursor);
  cursor += record.update.length;
  body.set(checksum(body.subarray(0, cursor)), cursor);
  return bytes;
}
