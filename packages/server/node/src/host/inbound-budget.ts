import * as decoding from 'lib0/decoding';

/**
 * One connection's inbound budget, the Node mirror of the C#
 * Blok.Server.AspNetCore.Collab.SyncInboundBudget. Without it a single
 * member — a read-only one included — monopolizes the room: every SyncStep1
 * makes the room diff the whole document back at the sender, every
 * queryAwareness makes every other member re-encode all the presence it
 * holds, and every awareness frame is relayed verbatim to everyone.
 *
 * The numbers: a fast typist commits ~10 updates a second and moves the
 * cursor at about 10 Hz, so ~25 frames/s is the busiest legitimate
 * connection — the 50/s default is double that, and the 100-frame burst
 * absorbs a reconnect flurry or a big paste. Resyncs and presence re-queries
 * are rarer still (one resync per connect; the most eager clients re-ask
 * every 5 s, ~12/min, and no stock client ever sends a queryAwareness), so
 * they carry their own tighter budget on top. Presence is metered by BYTES
 * as well, because the frame budget cannot tell a cursor move from the
 * 683 KB of fabricated peers that also fits one legal frame.
 *
 * PER CONNECTION, never per room: only its connection's receive loop touches
 * it, which is why nothing here is guarded and why it must never be filed
 * beside a room's shared counters.
 */

/** A flaky reconnect can legitimately land a few resyncs at once. */
const AMPLIFIER_BURST = 10;

/**
 * Presence bytes admitted back-to-back — several times a full presence reply
 * in a large room, so a client answering queryAwareness is never the one that
 * gets closed. A single frame costing more than this can never be paid for,
 * which is what a fabricated-peer frame is.
 */
const AWARENESS_BURST_BYTES = 512 * 1024;

const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1_000;

/** lib0 varuints are unbounded; a 64-bit value is at most ten LEB128 bytes. */
const MAX_VARUINT_BYTES = 10;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const SYNC_STEP1 = 0;

/**
 * Every receive costs a loop turn however few bytes it carries, so a message
 * sent as empty or one-byte fragments would spend the server's CPU for almost
 * nothing — and the frame budget only sees a message once it ends. A message
 * may take this many receives plus one per MIN_BYTES_PER_RECEIVE of its
 * bytes: far more than any real transport needs (a stream read hands back at
 * least a TCP segment), and the flood is closed at the seventeenth fragment.
 */
export const RECEIVE_SLACK = 16;

export const MIN_BYTES_PER_RECEIVE = 64;

/** The four CollabInbound* options. A rate of zero turns that bucket off. */
export interface InboundBudgetOptions {
  framesPerSecond: number;
  burstFrames: number;
  resyncsPerMinute: number;
  awarenessBytesPerSecond: number;
}

/** BlokServerOptions' defaults, byte for byte. */
export const DEFAULT_INBOUND_BUDGET: InboundBudgetOptions = {
  framesPerSecond: 50,
  burstFrames: 100,
  resyncsPerMinute: 60,
  awarenessBytesPerSecond: 128 * 1024,
};

/** Refills at `perSecond` up to `capacity`; a rate of zero or less is off. */
export class TokenBucket {
  private tokens: number;
  private stamp: number;

  constructor(
    private readonly now: () => number,
    private readonly perSecond: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
    this.stamp = now();
  }

  /** A cost above the whole capacity can never be paid, so it is refused. */
  tryTake(cost = 1): boolean {
    if (this.perSecond <= 0) {
      return true;
    }

    const now = this.now();
    const elapsed = (now - this.stamp) / MILLISECONDS_PER_SECOND;

    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perSecond);
    this.stamp = now;

    if (this.tokens < cost) {
      return false;
    }

    this.tokens -= cost;

    return true;
  }
}

/** What a frame costs beyond one slot of the frame budget. */
type FrameClass =
  /** Costs the sender alone. */
  | 'plain'
  /** SyncStep1 or queryAwareness: cheap to send, answered room-wide. */
  | 'amplifier'
  /** Awareness: relayed verbatim to every other member, byte for byte. */
  | 'presence';

/**
 * Reads one lib0 varuint with the server's strict bounds: at most ten bytes,
 * and never a throw. lib0's own reader throws on a truncated varuint and
 * accepts an over-long encoding, so the length is checked after the fact and
 * the throw is caught — matching SyncWire.TryReadVarUint's `false`.
 */
function readVarUint(decoder: decoding.Decoder): number | null {
  const start = decoder.pos;

  try {
    const value = decoding.readVarUint(decoder);

    return decoder.pos - start > MAX_VARUINT_BYTES ? null : value;
  } catch {
    return null;
  }
}

/**
 * Reads the message type — and the sync sub-type behind it — with the codec's
 * own varuint reader, never by comparing raw bytes: lib0 varuints are not
 * canonical, so [0x80, 0x00] also decodes as 0 and a byte compare would wave
 * a whole resync storm past its budget while the room answers every frame
 * of it. An undecodable frame is dropped by the room, so it costs nobody but
 * the sender: plain.
 */
function classify(frame: Uint8Array): FrameClass {
  const decoder = decoding.createDecoder(frame);
  const messageType = readVarUint(decoder);

  if (messageType === MESSAGE_AWARENESS) {
    return 'presence';
  }

  if (messageType === MESSAGE_QUERY_AWARENESS) {
    return 'amplifier';
  }

  if (messageType !== MESSAGE_SYNC) {
    return 'plain';
  }

  return readVarUint(decoder) === SYNC_STEP1 ? 'amplifier' : 'plain';
}

export class InboundBudget {
  private readonly frames: TokenBucket;
  private readonly amplifiers: TokenBucket;
  private readonly awarenessBytes: TokenBucket;
  private receives = 0;

  constructor(
    options: InboundBudgetOptions = DEFAULT_INBOUND_BUDGET,
    now: () => number = () => Date.now(),
  ) {
    this.frames = new TokenBucket(now, options.framesPerSecond, options.burstFrames);
    this.amplifiers = new TokenBucket(now, options.resyncsPerMinute / SECONDS_PER_MINUTE, AMPLIFIER_BURST);
    this.awarenessBytes = new TokenBucket(now, options.awarenessBytesPerSecond, AWARENESS_BURST_BYTES);
  }

  /** False when the frame is over budget; the caller closes 1008 "inbound rate exceeded". */
  allows(frame: Uint8Array): boolean {
    if (!this.frames.tryTake()) {
      return false;
    }

    const frameClass = classify(frame);

    if (frameClass === 'amplifier') {
      return this.amplifiers.tryTake();
    }

    if (frameClass === 'presence') {
      return this.awarenessBytes.tryTake(frame.length);
    }

    return true;
  }

  /**
   * One turn of the receive loop. `messageBytes` is everything the message
   * holds INCLUDING this receive. False past the allowance; the caller closes
   * 1008 the same way.
   */
  allowsReceive(messageBytes: number): boolean {
    this.receives += 1;

    return this.receives <= RECEIVE_SLACK + Math.floor(messageBytes / MIN_BYTES_PER_RECEIVE);
  }

  /** The message ended: the next one starts its receive allowance over. */
  endMessage(): void {
    this.receives = 0;
  }
}
