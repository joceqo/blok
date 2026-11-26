import type { Socket } from 'node:net';
import { Body, BodyState, Chunk, FramingTag, readBody } from './body.ts';
import { type Config } from './config.ts';
import {
  Answer,
  Deadline,
  Exchange,
  Framing,
  Limits,
  RST_AVOIDANCE,
  bareAnswer,
  responseHeadBytes,
} from './exchange.ts';
import {
  HeadScan,
  type Head,
  type Refusal,
  Version,
  finalCodingIsChunked,
  parseContentLength,
} from './head.ts';
import { Headers } from './headers.ts';
import { Inbound } from './inbound.ts';
import { CancelToken, Extensions, makeRequest } from './request.ts';
import { ResponseWriter } from './response.ts';
import { writeAll } from './socket.ts';
import { AsyncMutex, Mutex, lock, watchChannel } from './sync.ts';

const REFUSAL_END_GRACE = 5;
const DRAIN_GRACE = 6000;

interface Shared {
  config: Config;
  handler: (request: import('./request.ts').Request, response: ResponseWriter) => Promise<void>;
  stopping: boolean;
}

function refusalAnswer(refusal: Refusal): Answer {
  if (refusal.kind === 'status') {
    return { tag: 'Status', status: refusal.status };
  }
  if (refusal.kind === 'goaway') {
    return { tag: 'GoAway' };
  }
  return { tag: 'MethodNotAllowed', allow: refusal.allow };
}

/** A deadline that can be dropped before it fires. */
function deadline(atMs: number): { expiry: Promise<never>; drop: () => void } {
  const handle: { timer?: ReturnType<typeof setTimeout> } = {};
  const expiry = new Promise<never>((_, reject) => {
    handle.timer = setTimeout(() => reject(new Error('timeout')), Math.max(0, atMs - Date.now()));
  });
  return { expiry, drop: () => clearTimeout(handle.timer) };
}

/**
 * Runs the handler under the request deadline, which a hijack drops. A hijacked
 * handler owns the socket for the whole session it serves — a WebSocket outlives
 * any request timeout — and `serve` destroys that socket the moment the handler
 * returns. So the deadline is dropped, not merely ignored.
 */
async function underDeadline(run: () => Promise<void>, deadlineAt: number, exchange: Exchange): Promise<void> {
  // Armed before the handler starts, so a hijack cannot slip past the watch.
  const hijacked = exchange.hijacked.notified();
  hijacked.enable();
  const { expiry, drop } = deadline(deadlineAt);
  void hijacked.wait().then(drop);
  try {
    await Promise.race([run(), expiry]);
  } finally {
    drop();
    hijacked.cancel();
  }
}

async function waitForRequest(shared: Shared, inbound: Inbound): Promise<boolean> {
  const idleDeadline = Date.now() + shared.config.keepAliveTimeoutMs;
  for (;;) {
    {
      const state = inbound.lock();
      let skip = 0;
      while (skip < state.buf.length && (state.buf[skip] === 0x0d || state.buf[skip] === 0x0a)) {
        skip += 1;
      }
      if (skip > 0) {
        state.consume(skip);
      }
      if (state.buf.length > 0) {
        return true;
      }
      if (state.ended()) {
        return false;
      }
    }
    inbound.wakeReader();
    if (shared.stopping) {
      return false;
    }
    const raced = await Promise.race([
      inbound.waitForMore(0),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(0, idleDeadline - Date.now()))),
    ]);
    if (raced === 'timeout') {
      return false;
    }
  }
}

async function closeSoftly(inbound: Inbound, socket: Socket): Promise<void> {
  socket.end();
  const deadline = Date.now() + RST_AVOIDANCE;
  while (Date.now() < deadline) {
    const state = inbound.lock();
    if (state.ended()) {
      return;
    }
    await inbound.waitForMore(state.buf.length);
  }
}

async function drain(exchange: Exchange): Promise<boolean> {
  const guard = await exchange.body.lock();
  if (guard.get().failed !== undefined || guard.get().done()) {
    guard.release();
    return guard.get().failed === undefined;
  }
  guard.release();
  const chunk = new Uint8Array(16 << 10);
  const started = Date.now();
  for (;;) {
    if (Date.now() - started >= DRAIN_GRACE) {
      return false;
    }
    try {
      const n = await readBody(exchange, chunk, false);
      if (n === 0) {
        return true;
      }
    } catch {
      return false;
    }
  }
}

async function runExchange(
  shared: Shared,
  inbound: Inbound,
  head: Head,
  socket: Socket,
  releaseGuard: () => void,
): Promise<boolean> {
  const config = shared.config;
  const chunked = head.headers.contains('transfer-encoding') && finalCodingIsChunked(head.headers);
  const lengthRaw = chunked ? undefined : head.headers.get('content-length');
  const length = lengthRaw !== undefined ? parseContentLength(lengthRaw) : undefined;
  const framing =
    chunked
      ? { tag: FramingTag.Chunked as const, chunk: Chunk.Size }
      : length === undefined || length === 0n
        ? { tag: FramingTag.Empty as const }
        : { tag: FramingTag.Length as const, remaining: Number(length) };
  const requestClose =
    head.headers.hasToken('connection', 'close')
    || (head.headers.contains('transfer-encoding') && head.headers.contains('content-length'));
  const keepAlive10 = head.version === Version.Http10 && head.headers.hasToken('connection', 'keep-alive');
  const { sender: cancel, receiver: cancelReceiver } = watchChannel(false);
  const { sender: expired, receiver: expiredReceiver } = watchChannel(false);
  const limits = new Mutex(new Limits(config.maxRequestBody, length === undefined ? undefined : Number(length)));
  const exchange = new Exchange({
    config,
    inbound,
    wire: new AsyncMutex({
      socket,
      started: false,
      framing: Framing.None,
      hostOwned: false,
      pendingTimeout: false,
      finished: false,
      close: false,
      hijacked: false,
      expired: expiredReceiver,
      inbound,
    }),
    body: new AsyncMutex(new BodyState(framing, head.headerBytes, head.headers.len())),
    limits,
    deadline: new Mutex(new Deadline()),
    left: new Mutex(undefined),
    active: new Mutex(releaseGuard),
    methodHead: head.method === 'HEAD',
    version: head.version,
    requestClose,
    keepAlive10,
    expectsContinue:
      head.version === Version.Http11
      && head.headers.getAll('expect').some((v) => v.trim().toLowerCase() === '100-continue'),
    stopping: { load: () => shared.stopping },
    cancel,
    expired,
  });
  const request = makeRequest({
    method: head.method,
    target: head.target,
    form: head.form,
    path: head.path,
    query: head.query,
    version: head.version,
    headers: head.headers,
    remoteAddr: socket.remoteAddress,
    remotePort: socket.remotePort,
    localAddr: socket.localAddress,
    localPort: socket.localPort,
    body: new Body(exchange),
    cancel: CancelToken.fromReceiver(cancelReceiver),
    exchange,
    extensions: new Extensions(),
  });
  const response = new ResponseWriter(exchange);
  const deadlineAt = config.requestTimeoutMs === undefined ? undefined : Date.now() + config.requestTimeoutMs;
  try {
    if (deadlineAt !== undefined) {
      await underDeadline(() => shared.handler(request, response), deadlineAt, exchange);
    } else {
      await shared.handler(request, response);
    }
  } catch {
    await exchange.refuseUnhandled();
  } finally {
    response.dropState();
  }
  const wireGuard = await exchange.wire.lock();
  const wire = wireGuard.get();
  if (wire.hijacked) {
    wireGuard.release();
    return false;
  }
  if (!wire.started && inbound.lock().ended()) {
    // Kestrel drops a request whose peer half-closed: no answer.
    wire.close = true;
  } else if (!wire.started) {
    const left = exchange.left.lock().get() ?? [200, new Headers()];
    const [status, headers] = left;
    wire.started = true;
    const built = responseHeadBytes(exchange, wire, status === 0 ? 200 : status, headers, true);
    if ('refused' in built) {
      await writeAll(socket, built.refused);
    } else {
      await writeAll(socket, built);
    }
    // Content-Length set but never written: peer would read the next answer as body.
    if (typeof wire.framing === 'object' && wire.framing.tag === 'Length' && wire.framing.remaining > 0) {
      wire.close = true;
    }
  } else if (!wire.hostOwned) {
    // Handler already started the answer — finish chunked framing, or abort a short Length body.
    if (wire.framing === Framing.Chunked) {
      try {
        await writeAll(socket, Buffer.from('0\r\n\r\n'));
      } catch {
        wire.close = true;
      }
    } else if (typeof wire.framing === 'object' && wire.framing.tag === 'Length' && wire.framing.remaining > 0) {
      wire.close = true;
    }
  }
  const close = wire.close;
  wire.finished = true;
  wireGuard.release();
  if (close) {
    await closeSoftly(inbound, socket);
    return false;
  }
  if (!(await drain(exchange))) {
    await closeSoftly(inbound, socket);
    return false;
  }
  return true;
}

export async function serve(shared: Shared, socket: Socket, releaseGuard: () => void): Promise<void> {
  const inbound = Inbound.start(socket);
  const headerTimeout = shared.config.headerTimeoutMs;
  try {
    for (;;) {
      if (!(await waitForRequest(shared, inbound))) {
        break;
      }
      const headerDeadline = Date.now() + headerTimeout;
      const scan = HeadScan.new();
      let parsed: { head: Head; consumed: number } | { refusal: Answer | undefined } | undefined;
      for (;;) {
        const state = inbound.lock();
        const result = scan.parse(state.buf);
        if (result.kind === 'done') {
          parsed = { head: result.head, consumed: result.consumed };
          break;
        }
        if (result.kind === 'refused') {
          parsed = { refusal: refusalAnswer(result.refusal) };
          break;
        }
        if (state.ended()) {
          parsed = { refusal: undefined };
          break;
        }
        const have = state.buf.length;
        const ok = await Promise.race([
          inbound.waitForMore(have),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(0, headerDeadline - Date.now()))),
        ]);
        if (ok === 'timeout') {
          parsed = { refusal: { tag: 'Status', status: 408 } };
          break;
        }
      }
      if (!('head' in parsed!)) {
        const answer = 'refusal' in parsed! ? parsed.refusal : undefined;
        if (answer !== undefined) {
          await Promise.race([
            inbound.waitUntil((s) => s.ended()),
            new Promise((r) => setTimeout(r, REFUSAL_END_GRACE)),
          ]);
          if (!(await inbound.peerEnded(socket))) {
            await writeAll(socket, bareAnswer(shared.config, answer));
          }
        }
        await closeSoftly(inbound, socket);
        break;
      }
      inbound.consume(parsed.consumed);
      if (!(await runExchange(shared, inbound, parsed.head, socket, releaseGuard))) {
        break;
      }
    }
  } finally {
    releaseGuard();
    socket.destroy();
  }
}
