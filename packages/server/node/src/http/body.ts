/** Request body read as Kestrel reads it. */

import type { Exchange } from './exchange.ts';
import { sendWire } from './exchange.ts';
import { MAX_HEADER_BLOCK, MAX_HEADER_COUNT } from './head.ts';

export interface BodyRate {
  bytesPerSecond: number;
  graceMs: number;
}

export enum BodyError {
  TooLarge = 'TooLarge',
  TooSlow = 'TooSlow',
  Malformed = 'Malformed',
  HeadersTooLarge = 'HeadersTooLarge',
  BadTrailer = 'BadTrailer',
  Overflow = 'Overflow',
  UnexpectedEof = 'UnexpectedEof',
  Deadline = 'Deadline',
  Io = 'Io',
}

export enum FramingTag {
  Empty = 'Empty',
  Length = 'Length',
  Chunked = 'Chunked',
}

export enum Chunk {
  Size = 'Size',
  Extension = 'Extension',
  Data = 'Data',
  DataEnd = 'DataEnd',
  Trailers = 'Trailers',
  Done = 'Done',
}

export type BodyFraming =
  | { tag: FramingTag.Empty }
  | { tag: FramingTag.Length; remaining: number }
  | { tag: FramingTag.Chunked; chunk: Chunk; size?: number };

export class BodyState {
  framing: BodyFraming;
  read = 0;
  waitedMs = 0;
  failed: BodyError | undefined;
  trailerBytes: number;
  trailerLines: number;
  trailerSeen = false;
  continued = false;

  constructor(framing: BodyFraming, headBytes: number, headLines: number) {
    this.framing = framing;
    this.trailerBytes = headBytes;
    this.trailerLines = headLines;
  }

  done(): boolean {
    const f = this.framing;
    return (
      f.tag === FramingTag.Empty
      || (f.tag === FramingTag.Length && f.remaining === 0)
      || (f.tag === FramingTag.Chunked && f.chunk === Chunk.Done)
    );
  }
}

export class Body {
  constructor(readonly exchange: Exchange) {}

  setLimit(limit: number): void {
    const limits = this.exchange.limits.lock().get();
    if (!limits.started) {
      limits.limit = limit;
      limits.routeSet = true;
    }
  }

  async read(buf: Uint8Array): Promise<number> {
    return readBody(this.exchange, buf, true);
  }

  async readToEnd(out: Uint8Array[]): Promise<void> {
    const chunk = new Uint8Array(16 << 10);
    for (;;) {
      const n = await this.read(chunk);
      if (n === 0) {
        return;
      }
      out.push(chunk.slice(0, n));
    }
  }
}

export async function readBody(exchange: Exchange, buf: Uint8Array, answer: boolean): Promise<number> {
  const bodyGuard = await exchange.body.lock();
  const state = bodyGuard.get();
  if (state.failed !== undefined) {
    const err = state.failed;
    bodyGuard.release();
    throw err;
  }
  if (state.done()) {
    bodyGuard.release();
    return 0;
  }
  const limits = exchange.limits.lock().get();
  const first = !limits.started;
  limits.started = true;
  const routeSet = limits.routeSet;
  const limit = limits.limit;
  if (first && state.framing.tag === FramingTag.Length && state.framing.remaining > limit) {
    bodyGuard.release();
    throw await fail(exchange, state, BodyError.TooLarge, routeSet, answer);
  }
  if (buf.length === 0) {
    bodyGuard.release();
    return 0;
  }
  for (;;) {
    const stepped = step(exchange, state, buf);
    exchange.inbound.wakeReader();
    if (stepped.tag === 'Read') {
      state.read += stepped.n;
      if (state.read > limit) {
        bodyGuard.release();
        throw await fail(exchange, state, BodyError.TooLarge, routeSet, answer);
      }
      bodyGuard.release();
      return stepped.n;
    }
    if (stepped.tag === 'End') {
      bodyGuard.release();
      return 0;
    }
    if (stepped.tag === 'Fail') {
      bodyGuard.release();
      throw await fail(exchange, state, stepped.error, routeSet, answer);
    }
    if (stepped.tag === 'Wait') {
      if (answer && exchange.expectsContinue && !state.continued) {
        state.continued = true;
        const wireGuard = await exchange.wire.lock();
        const wire = wireGuard.get();
        if (!wire.started && !wire.hijacked && wire.socket) {
          await sendWire(wire, Buffer.from('HTTP/1.1 100 Continue\r\n\r\n'));
        }
        wireGuard.release();
      }
      const waited = await wait(exchange, state, stepped.have, answer);
      if (waited !== undefined) {
        bodyGuard.release();
        throw await fail(exchange, state, waited, routeSet, answer);
      }
    }
    if (state.read > limit) {
      bodyGuard.release();
      throw await fail(exchange, state, BodyError.TooLarge, routeSet, answer);
    }
  }
}

type Step =
  | { tag: 'Read'; n: number }
  | { tag: 'End' }
  | { tag: 'Fail'; error: BodyError }
  | { tag: 'Progress' }
  | { tag: 'Wait'; have: number };

function step(exchange: Exchange, state: BodyState, buf: Uint8Array): Step {
  const inbound = exchange.inbound.lock();
  const available = inbound.buf.length;
  const ended = inbound.ended();
  const endedStep = (have: number): Step => (ended ? { tag: 'Fail', error: BodyError.UnexpectedEof } : { tag: 'Wait', have });
  const framing = state.framing;
  if (framing.tag === FramingTag.Empty) {
    return { tag: 'End' };
  }
  if (framing.tag === FramingTag.Length) {
    if (framing.remaining === 0) {
      return { tag: 'End' };
    }
    if (available === 0) {
      return endedStep(0);
    }
    const n = Math.min(framing.remaining, available, buf.length);
    buf.set(inbound.buf.subarray(0, n));
    inbound.consume(n);
    framing.remaining -= n;
    return { tag: 'Read', n };
  }
  if (framing.tag === FramingTag.Chunked) {
    return stepChunked(exchange, state, inbound, buf, endedStep);
  }
  return { tag: 'End' };
}

function stepChunked(
  exchange: Exchange,
  state: BodyState,
  inbound: ReturnType<Inbound['lock']>,
  buf: Uint8Array,
  endedStep: (have: number) => Step,
): Step {
  const framing = state.framing;
  if (framing.tag !== FramingTag.Chunked) {
    return { tag: 'End' };
  }
  const chunk = framing.chunk;
  const available = inbound.buf.length;
  if (chunk === Chunk.Data) {
    const remaining = framing.size ?? 0;
    if (available === 0) {
      return endedStep(0);
    }
    const n = Math.min(remaining, available, buf.length);
    buf.set(inbound.buf.subarray(0, n));
    inbound.consume(n);
    if (remaining === n) {
      framing.chunk = Chunk.DataEnd;
    } else {
      framing.size = remaining - n;
    }
    return { tag: 'Read', n };
  }
  if (chunk === Chunk.DataEnd) {
    if (available < 2) {
      return endedStep(available);
    }
    if (inbound.buf[0] !== 0x0d || inbound.buf[1] !== 0x0a) {
      return { tag: 'Fail', error: BodyError.Malformed };
    }
    inbound.consume(2);
    state.read += 2;
    framing.chunk = Chunk.Size;
    return { tag: 'Progress' };
  }
  if (chunk === Chunk.Trailers) {
    if (available < 2) {
      return endedStep(available);
    }
    let lf = -1;
    for (let i = 0; i < inbound.buf.length; i += 1) {
      if (inbound.buf[i] === 0x0a) {
        lf = i;
        break;
      }
    }
    if (lf === -1) {
      if (state.trailerBytes + available >= MAX_HEADER_BLOCK) {
        return { tag: 'Fail', error: BodyError.HeadersTooLarge };
      }
      return endedStep(available);
    }
    state.trailerBytes += lf + 1;
    if (state.trailerBytes > MAX_HEADER_BLOCK) {
      return { tag: 'Fail', error: BodyError.HeadersTooLarge };
    }
    if (lf === 0 || inbound.buf[lf - 1] !== 0x0d) {
      return { tag: 'Fail', error: BodyError.Malformed };
    }
    const line = inbound.buf.subarray(0, lf - 1);
    if (line.length === 0) {
      if (!state.trailerSeen) {
        state.read += lf + 1;
      }
      inbound.consume(lf + 1);
      framing.chunk = Chunk.Done;
      return { tag: 'Progress' };
    }
    if (state.trailerLines >= MAX_HEADER_COUNT) {
      return { tag: 'Fail', error: BodyError.HeadersTooLarge };
    }
    const trailerErr = checkTrailerLine(line);
    if (trailerErr !== undefined) {
      return { tag: 'Fail', error: trailerErr };
    }
    state.trailerLines += 1;
    state.trailerSeen = true;
    inbound.consume(lf + 1);
    return { tag: 'Progress' };
  }
  if (chunk === Chunk.Size) {
    const prefix = chunkPrefix(inbound.buf);
    if (prefix.tag === 'Err') {
      return { tag: 'Fail', error: prefix.error };
    }
    if (prefix.tag === 'More') {
      return endedStep(available);
    }
    if (prefix.tag === 'Extension') {
      inbound.consume(prefix.at + 1);
      state.read += prefix.at + 1;
      framing.chunk = Chunk.Extension;
      framing.size = prefix.size;
      return { tag: 'Progress' };
    }
    inbound.consume(prefix.len);
    state.read += prefix.len;
    if (prefix.size === 0) {
      framing.chunk = Chunk.Trailers;
    } else {
      framing.chunk = Chunk.Data;
      framing.size = prefix.size;
    }
    return { tag: 'Progress' };
  }
  if (chunk === Chunk.Extension) {
    const size = framing.size ?? 0;
    let lf = -1;
    for (let i = 0; i < inbound.buf.length; i += 1) {
      if (inbound.buf[i] === 0x0a) {
        lf = i;
        break;
      }
    }
    if (lf === -1) {
      if (available < 2) {
        return endedStep(available);
      }
      inbound.consume(available - 1);
      state.read += available - 1;
      return { tag: 'Progress' };
    }
    if (lf === 0 || inbound.buf[lf - 1] !== 0x0d) {
      return { tag: 'Fail', error: BodyError.Malformed };
    }
    inbound.consume(lf + 1);
    state.read += lf + 1;
    if (size === 0) {
      framing.chunk = Chunk.Trailers;
    } else {
      framing.chunk = Chunk.Data;
      framing.size = size;
    }
    return { tag: 'Progress' };
  }
  return { tag: 'End' };
}

import type { Inbound } from './inbound.ts';

function checkTrailerLine(line: Uint8Array): BodyError | undefined {
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === 0x3a) {
      colon = i;
      break;
    }
  }
  if (colon === -1) {
    return BodyError.Malformed;
  }
  const name = line.subarray(0, colon);
  const value = line.subarray(colon + 1);
  if (
    name.length === 0
    || name.some((b) => b === 0 || b === 0x09 || b === 0x0d || b === 0x20 || b >= 0x80)
  ) {
    return BodyError.Malformed;
  }
  if (value.includes(0x0d)) {
    return BodyError.Malformed;
  }
  if (value.includes(0) || !isUtf8(value)) {
    return BodyError.BadTrailer;
  }
  return undefined;
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const MAX_CHUNK_PREFIX = 10;

type PrefixResult =
  | { tag: 'More' }
  | { tag: 'Line'; size: number; len: number }
  | { tag: 'Extension'; size: number; at: number }
  | { tag: 'Err'; error: BodyError };

export function chunkPrefix(b: Uint8Array): PrefixResult {
  if (b.length < 2) {
    return { tag: 'More' };
  }
  let size: number;
  try {
    size = chunkDigit(b[0]!, 0);
  } catch (e) {
    return { tag: 'Err', error: e as BodyError };
  }
  let first = b[1]!;
  let consumed = 2;
  while (consumed < MAX_CHUNK_PREFIX) {
    if (first === 0x3b) {
      return { tag: 'Extension', size, at: consumed - 1 };
    }
    const second = b[consumed];
    if (second === undefined) {
      return { tag: 'More' };
    }
    consumed += 1;
    if (first === 0x0d && second === 0x0a) {
      return { tag: 'Line', size, len: consumed };
    }
    try {
      size = chunkDigit(first, size);
    } catch (e) {
      return { tag: 'Err', error: e as BodyError };
    }
    first = second;
  }
  return { tag: 'Err', error: BodyError.Malformed };
}

function chunkDigit(c: number, size: number): number {
  const ch = String.fromCharCode(c);
  const digit = Number.parseInt(ch, 16);
  if (Number.isNaN(digit) || ch.length > 1 || !/[0-9a-fA-F]/.test(ch)) {
    throw BodyError.Malformed;
  }
  const next = size * 16 + digit;
  if (next > 0x7fff_ffff) {
    throw BodyError.Overflow;
  }
  return next;
}

async function wait(exchange: Exchange, state: BodyState, have: number, rated: boolean): Promise<BodyError | undefined> {
  const deadline = exchange.bodyDeadline();
  const rate = rated ? exchange.config.minBodyRate : undefined;
  const started = Date.now();
  const slowAt =
    rate === undefined
      ? undefined
      : started + Math.max(rate.graceMs, (state.read / rate.bytesPerSecond) * 1000 - state.waitedMs) + 1;
  const until = [deadline, slowAt].filter((v): v is number => v !== undefined).reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  const waitPromise = exchange.inbound.waitForMore(have);
  const raced =
    until === Number.POSITIVE_INFINITY
      ? await waitPromise.then(() => true)
      : await Promise.race([
          waitPromise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(0, until - Date.now()))),
        ]);
  state.waitedMs += Date.now() - started;
  if (raced) {
    return undefined;
  }
  if (slowAt !== undefined && Date.now() >= slowAt && (deadline === undefined || Date.now() < deadline)) {
    exchange.cancelRequest();
    return BodyError.TooSlow;
  }
  return BodyError.Deadline;
}

async function fail(
  exchange: Exchange,
  state: BodyState,
  error: BodyError,
  routeSet: boolean,
  answer: boolean,
): Promise<BodyError> {
  state.failed = error;
  let status: number | undefined;
  switch (error) {
    case BodyError.TooLarge:
      status = 413;
      break;
    case BodyError.TooSlow:
      status = 408;
      break;
    case BodyError.Malformed:
      status = 400;
      break;
    case BodyError.HeadersTooLarge:
      status = 431;
      break;
    case BodyError.UnexpectedEof:
    case BodyError.Io:
      exchange.cancelRequest();
      break;
    default:
      break;
  }
  if (error === BodyError.Overflow || error === BodyError.BadTrailer) {
    if (answer && !routeSet) {
      await exchange.refuseUnhandled();
    } else {
      const wire = (await exchange.wire.lock()).get();
      wire.close = true;
    }
  }
  if (status !== undefined) {
    if (answer && !routeSet) {
      await exchange.refuse(status);
    } else {
      const wire = (await exchange.wire.lock()).get();
      wire.close = true;
    }
  }
  return error;
}