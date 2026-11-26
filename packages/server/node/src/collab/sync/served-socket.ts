import { isUtf8 } from 'node:buffer';
import type { Duplex } from 'node:stream';
import { WebSocket } from 'ws';

import type { InboundBudget } from '../../host/inbound-budget.ts';
import type { SocketBridge } from './socket-bridge.ts';
import { FrameReader, OP_CLOSE, OP_CONTINUATION, OP_PING, OP_PONG, OP_TEXT } from './ws-frames.ts';

/**
 * What one receive hands back: the reference hosts read into a 16 KiB buffer
 * and stop at the end of the frame, so a message dribbled a byte at a time
 * still costs one receive per frame and a large frame costs one per buffer.
 */
const RECEIVE_BYTES = 16 * 1024;

/** RFC 6455's close handshake, bounded: a peer owes its answer within this. */
export const CLOSE_GRACE_MS = 5_000;

export interface ServedSocketOptions {
  ws: WebSocket;
  bridge: SocketBridge;
  /** The connection itself; `ws` only ever sees the bridge. */
  wire: Duplex;
  /** Bytes the HTTP parser read past the request head. */
  buffered: Uint8Array;
  budget: InboundBudget;
  maxMessageBytes: number;
  closeGraceMs?: number;
}

/**
 * Reads the peer's frames and hands whole messages to `ws`, which the room
 * listens to. Everything the transport contract fixes lives here: the close
 * codes RFC 6455 owes a bad frame (always with an EMPTY reason), the message
 * cap, the inbound budget, the answer a peer's close earns, and the grace a
 * close of ours is given before the connection is dropped.
 */
export function serveSocket(options: ServedSocketOptions): void {
  const { ws, bridge, wire, budget, maxMessageBytes } = options;
  const graceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
  const reader = new FrameReader(maxMessageBytes);
  let parts: Buffer[] = [];
  let messageOpcode = OP_CONTINUATION;
  let messageBytes = 0;
  let closing = false;

  /**
   * Every close this host sends starts the grace, whoever decided it: the room
   * closes a member on what its frames said, and `ws`'s own wait is a module
   * constant no option reaches. It also turns the socket to reading and
   * dropping, since nothing past a close can still be served.
   */
  const closeOutput = ws.close.bind(ws);
  ws.close = (code?: number, data?: string | Buffer): void => {
    closeOutput(code, data);
    if (closing) {
      return;
    }
    closing = true;
    parts = [];
    const grace = setTimeout(() => wire.destroy(), graceMs);
    grace.unref();
    ws.once('close', () => clearTimeout(grace));
  };

  // `ws` no longer reads the connection, so its only error is one its own
  // writes raised; an unheard 'error' on an EventEmitter takes the host down.
  ws.on('error', () => wire.destroy());

  function fail(code: number, reason?: string): void {
    if (!closing) {
      ws.close(code, reason);
    }
  }

  /** A fault in the framing: what follows it on the stream means nothing. */
  function abort(code: number, reason?: string): void {
    fail(code, reason);
    bridge.endAfterFlush();
  }

  /** False once the socket is done with the stream. */
  function message(fin: boolean, opcode: number, payload: Buffer): boolean {
    if (closing) {
      return true;
    }
    if (opcode !== OP_CONTINUATION) {
      messageOpcode = opcode;
    }
    let left = payload.length;
    do {
      const taken = Math.min(left, RECEIVE_BYTES);
      left -= taken;
      messageBytes += taken;
      if (!budget.allowsReceive(messageBytes)) {
        fail(1008, 'inbound rate exceeded');
        return true;
      }
      if (messageBytes > maxMessageBytes) {
        fail(1009, 'message too big');
        return true;
      }
    } while (left > 0);
    parts.push(payload);
    if (!fin) {
      return true;
    }
    const [only] = parts;
    const whole = parts.length === 1 && only !== undefined ? only : Buffer.concat(parts);
    parts = [];
    messageBytes = 0;
    budget.endMessage();
    if (messageOpcode === OP_TEXT) {
      // The framing owes 1007 for text that is not UTF-8; only a well-formed
      // one gets to hear that this room reads binary.
      if (!isUtf8(whole)) {
        abort(1007);
        return false;
      }
      fail(1003, 'binary frames only');
      return true;
    }
    if (!budget.allows(whole)) {
      fail(1008, 'inbound rate exceeded');
      return true;
    }
    ws.emit('message', whole, true);
    return true;
  }

  function received(chunk: Buffer): void {
    for (const event of reader.read(chunk)) {
      if (event.kind === 'protocol-error') {
        abort(1002);
        return;
      }
      if (event.kind === 'too-large') {
        abort(1009, 'message too big');
        return;
      }
      if (event.opcode === OP_PING) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.pong(event.payload);
        }
        continue;
      }
      if (event.opcode === OP_PONG) {
        ws.emit('pong', event.payload);
        continue;
      }
      if (event.opcode === OP_CLOSE) {
        // A peer that opened the handshake is answered 1000 with no reason,
        // whatever its own close said; one that answered ours owes nothing.
        fail(1000);
        bridge.endAfterFlush();
        return;
      }
      if (!message(event.fin, event.opcode, event.payload)) {
        return;
      }
    }
  }

  wire.on('data', (chunk: Buffer) => received(chunk));
  // Through the stream, so the room's own listener is in place before the
  // first message: a frame handed over now would reach nobody.
  if (options.buffered.length > 0) {
    wire.unshift(Buffer.from(options.buffered));
  }
}
