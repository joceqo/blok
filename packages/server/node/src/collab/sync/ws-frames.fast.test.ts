import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  FrameReader,
  OP_BINARY,
  OP_CLOSE,
  OP_CONTINUATION,
  OP_PING,
  OP_TEXT,
  type FrameEvent,
} from './ws-frames.ts';

const FIN = 0x80;
const CAP = 1024 * 1024;

/** One client frame, masked the way RFC 6455 makes a client mask it. */
function client(first: number, payload: Uint8Array = new Uint8Array(), masked = true): Buffer {
  const maskBit = masked ? 0x80 : 0;
  let header: Buffer;
  if (payload.length <= 125) {
    header = Buffer.from([first, maskBit | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = maskBit | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  if (!masked) {
    return Buffer.concat([header, payload]);
  }
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) {
    body.writeUInt8(body.readUInt8(i) ^ mask.readUInt8(i & 3), i);
  }
  return Buffer.concat([header, mask, body]);
}

function closePayload(code: number, reason: Uint8Array = new Uint8Array()): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(code, 0);
  return Buffer.concat([head, Buffer.from(reason)]);
}

function readAll(bytes: Buffer, maxFrameBytes = CAP): FrameEvent[] {
  return new FrameReader(maxFrameBytes).read(bytes);
}

describe('FrameReader', () => {
  it('unmasks a binary frame and reports its payload', () => {
    expect(readAll(client(FIN | OP_BINARY, Buffer.from([1, 2, 3])))).toEqual([
      { kind: 'frame', fin: true, opcode: OP_BINARY, payload: Buffer.from([1, 2, 3]) },
    ]);
  });

  it('reads two frames out of one chunk, and one frame out of two chunks', () => {
    const pair = Buffer.concat([client(FIN | OP_BINARY, Buffer.from([7])), client(FIN | OP_PING)]);
    expect(readAll(pair).map((event) => event.kind === 'frame' && event.opcode)).toEqual([OP_BINARY, OP_PING]);

    const reader = new FrameReader(CAP);
    const whole = client(FIN | OP_BINARY, Buffer.from([9, 9]));
    expect(reader.read(whole.subarray(0, 4))).toEqual([]);
    expect(reader.read(whole.subarray(4))).toEqual([
      { kind: 'frame', fin: true, opcode: OP_BINARY, payload: Buffer.from([9, 9]) },
    ]);
  });

  it('waits for the four mask bytes before it judges an unmasked frame', () => {
    const reader = new FrameReader(CAP);
    const unmasked = client(FIN | OP_BINARY, Buffer.alloc(8), false);
    expect(reader.read(unmasked.subarray(0, 2))).toEqual([]);
    expect(reader.read(unmasked.subarray(2))).toEqual([{ kind: 'protocol-error' }]);
  });

  it('refuses a reserved bit and an unknown opcode', () => {
    expect(readAll(client(FIN | 0x40 | OP_BINARY, Buffer.from([1])))).toEqual([{ kind: 'protocol-error' }]);
    expect(readAll(client(FIN | 0x3, Buffer.from([1])))).toEqual([{ kind: 'protocol-error' }]);
  });

  it('refuses a continuation with nothing to continue, and serves one that continues a fragment', () => {
    expect(readAll(client(FIN | OP_CONTINUATION, Buffer.from([1])))).toEqual([{ kind: 'protocol-error' }]);

    const fragments = Buffer.concat([
      client(OP_BINARY, Buffer.from([1])),
      client(OP_CONTINUATION, Buffer.from([2])),
      client(FIN | OP_CONTINUATION, Buffer.from([3])),
    ]);
    expect(readAll(fragments).map((event) => event.kind)).toEqual(['frame', 'frame', 'frame']);
  });

  it('refuses a new message inside a fragmented one', () => {
    const interleaved = Buffer.concat([client(OP_BINARY, Buffer.from([1])), client(FIN | OP_BINARY, Buffer.from([2]))]);
    expect(readAll(interleaved)).toEqual([
      { kind: 'frame', fin: false, opcode: OP_BINARY, payload: Buffer.from([1]) },
      { kind: 'protocol-error' },
    ]);
  });

  it('refuses a fragmented control frame and one over 125 bytes', () => {
    expect(readAll(client(OP_PING, Buffer.from('x')))).toEqual([{ kind: 'protocol-error' }]);
    expect(readAll(client(FIN | OP_PING, Buffer.alloc(126)))).toEqual([{ kind: 'protocol-error' }]);
  });

  it('refuses a close of one byte, an invalid status, and a reason that is not UTF-8', () => {
    expect(readAll(client(FIN | OP_CLOSE, Buffer.from([3])))).toEqual([{ kind: 'protocol-error' }]);
    expect(readAll(client(FIN | OP_CLOSE, closePayload(1005)))).toEqual([{ kind: 'protocol-error' }]);
    expect(readAll(client(FIN | OP_CLOSE, closePayload(1004)))).toEqual([{ kind: 'protocol-error' }]);
    expect(readAll(client(FIN | OP_CLOSE, closePayload(1000, Buffer.from([0xff])))))
      .toEqual([{ kind: 'protocol-error' }]);
  });

  it('serves an empty close and one carrying a status with a UTF-8 reason', () => {
    expect(readAll(client(FIN | OP_CLOSE))).toEqual([
      { kind: 'frame', fin: true, opcode: OP_CLOSE, payload: Buffer.alloc(0) },
    ]);
    expect(readAll(client(FIN | OP_CLOSE, closePayload(1000, Buffer.from('bye', 'utf8'))))).toEqual([
      { kind: 'frame', fin: true, opcode: OP_CLOSE, payload: closePayload(1000, Buffer.from('bye')) },
    ]);
  });

  it('reports a data frame past the cap instead of buffering it', () => {
    const header = Buffer.alloc(10);
    header[0] = FIN | OP_BINARY;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(4 * 1024 * 1024), 2);
    expect(new FrameReader(CAP).read(Buffer.concat([header, Buffer.alloc(4)]))).toEqual([{ kind: 'too-large' }]);
  });

  it('stops reading once a frame broke the protocol', () => {
    const reader = new FrameReader(CAP);
    expect(reader.read(client(FIN | 0x3))).toEqual([{ kind: 'protocol-error' }]);
    expect(reader.read(client(FIN | OP_TEXT, Buffer.from('ok')))).toEqual([]);
  });
});
