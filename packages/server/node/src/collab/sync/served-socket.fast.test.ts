import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';

import { DEFAULT_INBOUND_BUDGET, InboundBudget } from '../../host/inbound-budget.ts';
import { SocketBridge } from './socket-bridge.ts';
import { serveSocket } from './served-socket.ts';
import { OP_BINARY, OP_CLOSE, OP_CONTINUATION, OP_PING, OP_PONG, OP_TEXT } from './ws-frames.ts';

const FIN = 0x80;
const CAP = 1024 * 1024;
const GRACE_MS = 30;

/** The connection as the host sees it: what it wrote, and what the peer wrote. */
class FakeWire extends Duplex {
  readonly sent: Buffer[] = [];

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.sent.push(Buffer.from(chunk));
    callback();
  }

  feed(bytes: Buffer): void {
    this.push(bytes);
  }
}

function client(first: number, payload: Uint8Array = new Uint8Array()): Buffer {
  let header: Buffer;
  if (payload.length <= 125) {
    header = Buffer.from([first, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) {
    body.writeUInt8(body.readUInt8(i) ^ mask.readUInt8(i & 3), i);
  }
  return Buffer.concat([header, mask, body]);
}

interface ServerFrame { fin: boolean; opcode: number; payload: Buffer }

/** Every unmasked frame the host wrote. */
function serverFrames(sent: Buffer[]): ServerFrame[] {
  let rest = Buffer.concat(sent);
  const frames: ServerFrame[] = [];
  for (;;) {
    if (rest.length < 2) {
      return frames;
    }
    const marker = rest.readUInt8(1) & 0x7f;
    const header = marker === 126 ? 4 : marker === 127 ? 10 : 2;
    const length = marker === 126 ? rest.readUInt16BE(2) : marker === 127 ? Number(rest.readBigUInt64BE(2)) : marker;
    if (rest.length < header + length) {
      return frames;
    }
    const first = rest.readUInt8(0);

    frames.push({
      fin: (first & 0x80) !== 0,
      opcode: first & 0x0f,
      payload: Buffer.from(rest.subarray(header, header + length)),
    });
    rest = rest.subarray(header + length);
  }
}

function closeFrame(sent: Buffer[]): { code: number | null; reason: string } | undefined {
  const frame = serverFrames(sent).find((candidate) => candidate.opcode === OP_CLOSE);
  if (frame === undefined) {
    return undefined;
  }
  return {
    code: frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null,
    reason: frame.payload.subarray(2).toString('utf8'),
  };
}

function closePayload(code: number, reason: Uint8Array = new Uint8Array()): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(code, 0);
  return Buffer.concat([head, Buffer.from(reason)]);
}

interface Served {
  ws: WebSocket;
  wire: FakeWire;
  messages: Buffer[];
  pongs: Buffer[];
  /** Every close the host reported, in the order it reported them. */
  closes: Array<{ code: number | undefined; reason: string }>;
}

/** One upgraded socket, served the way the host serves it. */
async function serve(buffered: Uint8Array = new Uint8Array()): Promise<Served> {
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const wire = new FakeWire();
  const bridge = new SocketBridge(wire);
  const request = {
    method: 'GET',
    url: '/sync/doc',
    httpVersion: '1.1',
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'),
    },
  } as unknown as IncomingMessage;
  const ws = await new Promise<WebSocket>((resolve) => {
    sockets.handleUpgrade(request, bridge, Buffer.alloc(0), (socket) => resolve(socket));
  });
  const messages: Buffer[] = [];
  const pongs: Buffer[] = [];
  const closes: Array<{ code: number | undefined; reason: string }> = [];

  ws.on('message', (data) => messages.push(data as Buffer));
  ws.on('pong', (data: Buffer) => pongs.push(data));
  // The 101 is not a frame, and every assertion here reads frames.
  wire.sent.length = 0;
  serveSocket({
    ws,
    bridge,
    wire,
    buffered,
    budget: new InboundBudget(DEFAULT_INBOUND_BUDGET),
    maxMessageBytes: CAP,
    closeGraceMs: GRACE_MS,
    onClose: (code, reason) => closes.push({ code, reason }),
  });

  return { ws, wire, messages, pongs, closes };
}

function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => resolve()));
}

function after(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('serveSocket', () => {
  it('hands a whole message to ws, fragments assembled', async () => {
    const { wire, messages } = await serve();

    wire.feed(client(FIN | OP_BINARY, Buffer.from([105, 1])));
    wire.feed(Buffer.concat([
      client(OP_BINARY, Buffer.from([105])),
      client(OP_CONTINUATION, Buffer.from([2])),
      client(FIN | OP_CONTINUATION, Buffer.from([3])),
    ]));
    await settled();

    expect(messages.map((message) => [...message])).toEqual([[105, 1], [105, 2, 3]]);
  });

  it('serves the bytes the handshake had already read', async () => {
    const { wire, messages } = await serve(client(FIN | OP_BINARY, Buffer.from([105, 4])));

    void wire;
    await settled();

    expect(messages.map((message) => [...message])).toEqual([[105, 4]]);
  });

  it('answers a ping with a pong carrying the same bytes, and reports a pong to ws', async () => {
    const { wire, pongs } = await serve();

    wire.feed(client(FIN | OP_PING, Buffer.from('are you there')));
    wire.feed(client(FIN | OP_PONG, Buffer.from('mine')));
    await settled();

    expect(serverFrames(wire.sent).map((frame) => [frame.opcode, frame.payload.toString()]))
      .toEqual([[OP_PONG, 'are you there']]);
    expect(pongs.map((pong) => pong.toString())).toEqual(['mine']);
  });

  it('answers the peer close with 1000 and no reason, then ends the wire', async () => {
    const { wire } = await serve();
    const finished = new Promise<void>((resolve) => wire.once('finish', () => resolve()));

    wire.feed(client(FIN | OP_CLOSE, closePayload(1000, Buffer.from('bye'))));
    await finished;

    expect(closeFrame(wire.sent)).toEqual({ code: 1000, reason: '' });
  });

  it('closes a text frame 1003, and waits the grace for a peer close that never comes', async () => {
    const { wire } = await serve();

    wire.feed(client(FIN | OP_TEXT, Buffer.from('hello')));
    await settled();

    expect(closeFrame(wire.sent)).toEqual({ code: 1003, reason: 'binary frames only' });
    expect(wire.destroyed).toBe(false);

    await after(GRACE_MS * 4);
    expect(wire.destroyed).toBe(true);
  });

  it('reads and drops frames after its close, and never sends a second one', async () => {
    const { wire, messages } = await serve();

    wire.feed(client(FIN | OP_TEXT, Buffer.from('hello')));
    await settled();
    wire.feed(client(FIN | OP_BINARY, Buffer.from([105])));
    wire.feed(client(FIN | OP_TEXT, Buffer.from('more')));
    wire.feed(client(FIN | OP_CLOSE, closePayload(1000)));
    await settled();

    expect(messages).toEqual([]);
    expect(serverFrames(wire.sent).filter((frame) => frame.opcode === OP_CLOSE)).toHaveLength(1);
  });

  it('closes 1007 with no reason for a text frame that is not UTF-8', async () => {
    const { wire } = await serve();

    wire.feed(client(FIN | OP_TEXT, Buffer.from([0xc3, 0x28])));
    await settled();

    expect(closeFrame(wire.sent)).toEqual({ code: 1007, reason: '' });
  });

  it('closes 1002 with no reason for a framing fault', async () => {
    const { wire } = await serve();

    wire.feed(client(FIN | 0x40 | OP_BINARY, Buffer.from([105])));
    await settled();

    expect(closeFrame(wire.sent)).toEqual({ code: 1002, reason: '' });
  });

  it('serves a message of exactly the cap and closes one byte over it 1009', async () => {
    const atCap = await serve();

    atCap.wire.feed(client(FIN | OP_BINARY, Buffer.alloc(CAP, 105)));
    await settled();
    expect(atCap.messages.map((message) => message.length)).toEqual([CAP]);
    expect(closeFrame(atCap.wire.sent)).toBeUndefined();

    const over = await serve();

    over.wire.feed(client(OP_BINARY, Buffer.alloc(1000, 105)));
    over.wire.feed(client(FIN | OP_CONTINUATION, Buffer.alloc(CAP + 1 - 1000)));
    await settled();
    expect(closeFrame(over.wire.sent)).toEqual({ code: 1009, reason: 'message too big' });
  });

  it('serves a message in 16 receives and closes the 17th 1008', async () => {
    const fragments = (count: number): Buffer => Buffer.concat([
      client(OP_BINARY),
      ...Array.from({ length: count - 2 }, () => client(OP_CONTINUATION)),
      client(FIN | OP_CONTINUATION, Buffer.from([105])),
    ]);

    const sixteen = await serve();

    sixteen.wire.feed(fragments(16));
    await settled();
    expect(closeFrame(sixteen.wire.sent)).toBeUndefined();
    expect(sixteen.messages).toHaveLength(1);

    const seventeen = await serve();

    seventeen.wire.feed(fragments(17));
    await settled();
    expect(closeFrame(seventeen.wire.sent)).toEqual({ code: 1008, reason: 'inbound rate exceeded' });
  });

  it('counts one receive for a frame dribbled a byte at a time', async () => {
    const { wire, messages } = await serve();
    const frame = client(FIN | OP_BINARY, Buffer.alloc(1024, 105));

    for (const byte of frame) {
      wire.feed(Buffer.from([byte]));
    }
    await settled();

    expect(closeFrame(wire.sent)).toBeUndefined();
    expect(messages).toHaveLength(1);
  });

  it('closes 1008 past the frame burst, and past the resync burst', async () => {
    const burst = await serve();

    burst.wire.feed(Buffer.concat(Array.from({ length: 150 }, () => client(FIN | OP_BINARY, Buffer.from([105])))));
    await settled();
    expect(closeFrame(burst.wire.sent)).toEqual({ code: 1008, reason: 'inbound rate exceeded' });

    // [0x80, 0x00] is a non-canonical 0: still a sync frame, and a resync.
    const resync = Buffer.from([0x80, 0x00, 0x00, 0x00]);
    const ten = await serve();

    ten.wire.feed(Buffer.concat(Array.from({ length: 10 }, () => client(FIN | OP_BINARY, resync))));
    await settled();
    expect(closeFrame(ten.wire.sent)).toBeUndefined();

    const twenty = await serve();

    twenty.wire.feed(Buffer.concat(Array.from({ length: 20 }, () => client(FIN | OP_BINARY, resync))));
    await settled();
    expect(closeFrame(twenty.wire.sent)).toEqual({ code: 1008, reason: 'inbound rate exceeded' });
  });

  it('closes 1008 for one awareness frame over the burst of presence bytes', async () => {
    const { wire } = await serve();
    const awareness = Buffer.alloc(512 * 1024 + 1);

    awareness[0] = 1;
    wire.feed(client(FIN | OP_BINARY, awareness));
    await settled();

    expect(closeFrame(wire.sent)).toEqual({ code: 1008, reason: 'inbound rate exceeded' });
  });
});

/**
 * Every close this host sends already funnels through one override, which is
 * why it is also the one place that can report them. The room decides most of
 * them — a queue overflow, a malformed awareness frame, a forbidden recheck —
 * and before this nothing anywhere kept the code it chose.
 */
describe('@fast reporting a close', () => {
  it('reports the code and reason the host chose', async () => {
    const { ws, closes } = await serve();

    ws.close(1008, 'room queue overflow');
    await settled();

    expect(closes).toEqual([{ code: 1008, reason: 'room queue overflow' }]);
  });

  it('reports the close the transport itself decided', async () => {
    const { wire, closes } = await serve();

    wire.feed(client(FIN | OP_TEXT, Buffer.from('hello')));
    await settled();

    expect(closes).toEqual([{ code: 1003, reason: 'binary frames only' }]);
  });

  it('reports a close once, however many times it is asked for', async () => {
    const { ws, closes } = await serve();

    ws.close(1009, 'message too big');
    ws.close(1011, 'room error');
    await settled();

    expect(closes).toEqual([{ code: 1009, reason: 'message too big' }]);
  });

  it('reports the answer a peer close earns, so the caller may judge it', async () => {
    const { wire, closes } = await serve();

    wire.feed(client(FIN | OP_CLOSE, closePayload(1000)));
    await settled();

    expect(closes).toEqual([{ code: 1000, reason: '' }]);
  });
});
