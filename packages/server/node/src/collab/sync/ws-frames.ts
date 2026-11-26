import { isUtf8 } from 'node:buffer';

/**
 * The host reads the peer's frames itself rather than letting `ws` do it: the
 * transport contract fixes a close code and an EMPTY reason for every framing
 * fault, meters the receives a message takes, and answers a peer's close with
 * 1000 — none of which `ws` can be told to do. `ws` keeps the outbound side,
 * where its framing is exactly right.
 */

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

const FIN_BIT = 0x80;
const RESERVED_BITS = 0x70;
const MASK_BIT = 0x80;
const OPCODE = 0x0f;
const LENGTH = 0x7f;
const MASK_BYTES = 4;

/** RFC 6455 §5.5: a control frame carries at most this, and is never fragmented. */
const MAX_CONTROL_PAYLOAD = 125;

export type FrameEvent =
  | { kind: 'frame'; fin: boolean; opcode: number; payload: Buffer }
  /** The peer broke the framing; the socket owes it a 1002 with no reason. */
  | { kind: 'protocol-error' }
  /** One frame alone is past the message cap, so it is refused unread. */
  | { kind: 'too-large' };

/** Close statuses a peer may send: 1000-1003, 1007-1014 and the private range. */
function validCloseStatus(status: number): boolean {
  if (status < 1000 || status >= 5000) {
    return false;
  }
  return status >= 3000 || status <= 1003 || (status >= 1007 && status <= 1014);
}

/**
 * A close carries nothing, or a status and a reason. One byte names no status,
 * and a reason that is not UTF-8 is a framing fault — 1002, not the 1007 a
 * text message earns.
 */
function validClose(payload: Buffer): boolean {
  if (payload.length === 0) {
    return true;
  }
  return payload.length >= 2 && validCloseStatus(payload.readUInt16BE(0)) && isUtf8(payload.subarray(2));
}

/** Four bytes at a time; the tail takes the first bytes of the key again. */
function unmask(payload: Buffer, mask: Buffer): void {
  const key = mask.readUInt32BE(0);
  let index = 0;
  for (; index + 4 <= payload.length; index += 4) {
    payload.writeUInt32BE((payload.readUInt32BE(index) ^ key) >>> 0, index);
  }
  for (let rest = 0; index < payload.length; index++, rest++) {
    payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(rest), index);
  }
}

/**
 * Turns the bytes a client writes into frames. It owns the fragmentation
 * state, so it alone can tell a continuation that continues something from one
 * that continues nothing, and it stops at the first fault: after one the
 * stream means nothing.
 */
export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);
  /** The last DATA frame's FIN; a control frame never interrupts a fragment. */
  private lastFin = true;
  private failed = false;

  constructor(private readonly maxFrameBytes: number) {}

  read(chunk: Buffer): FrameEvent[] {
    if (this.failed) {
      return [];
    }
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const events: FrameEvent[] = [];
    for (;;) {
      const event = this.take();
      if (event === undefined) {
        return events;
      }
      events.push(event);
      if (event.kind !== 'frame') {
        this.failed = true;
        this.pending = Buffer.alloc(0);
        return events;
      }
    }
  }

  /** The next frame, or undefined while the bytes for one have not all arrived. */
  private take(): FrameEvent | undefined {
    const buffer = this.pending;
    if (buffer.length < 2) {
      return undefined;
    }
    const marker = buffer.readUInt8(1) & LENGTH;
    const extended = marker === 126 ? 2 : marker === 127 ? 8 : 0;
    // A server reads the four mask bytes before it judges the mask bit, so a
    // frame that clears it is refused on the same header read as one that sets it.
    const header = 2 + extended + MASK_BYTES;
    if (buffer.length < header) {
      return undefined;
    }
    const length = extended === 0 ? marker
      : extended === 2 ? buffer.readUInt16BE(2)
        : Number(buffer.readBigUInt64BE(2));
    const first = buffer.readUInt8(0);
    const fin = (first & FIN_BIT) !== 0;
    const opcode = first & OPCODE;
    const control = opcode >= OP_CLOSE;
    if ((first & RESERVED_BITS) !== 0 || !Number.isSafeInteger(length) || (buffer.readUInt8(1) & MASK_BIT) === 0) {
      return { kind: 'protocol-error' };
    }
    if (!this.allowed(fin, opcode, length)) {
      return { kind: 'protocol-error' };
    }
    if (!control && length > this.maxFrameBytes) {
      return { kind: 'too-large' };
    }
    if (buffer.length < header + length) {
      return undefined;
    }
    const payload = Buffer.from(buffer.subarray(header, header + length));
    unmask(payload, buffer.subarray(header - MASK_BYTES, header));
    this.pending = buffer.subarray(header + length);
    if (!control) {
      this.lastFin = fin;
    }
    if (opcode === OP_CLOSE && !validClose(payload)) {
      return { kind: 'protocol-error' };
    }
    return { kind: 'frame', fin, opcode, payload };
  }

  private allowed(fin: boolean, opcode: number, length: number): boolean {
    switch (opcode) {
      case OP_CONTINUATION:
        return !this.lastFin;
      case OP_TEXT:
      case OP_BINARY:
        return this.lastFin;
      case OP_CLOSE:
      case OP_PING:
      case OP_PONG:
        return fin && length <= MAX_CONTROL_PAYLOAD;
      default:
        return false;
    }
  }
}
