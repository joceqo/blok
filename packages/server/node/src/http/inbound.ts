/** Read side of one connection — background reader fills a shared buffer. */

import type { Socket } from 'node:net';
import { Notify, Mutex } from './sync.ts';

const CAP = 64 << 10;
const READ_SIZE = 16 << 10;
const PEEK_TRIES = 8;

export class State {
  buf: Uint8Array = new Uint8Array(0);
  eof = false;
  error: NodeJS.ErrnoException | undefined;
  stop = false;

  ended(): boolean {
    return this.eof || this.error !== undefined;
  }

  consume(n: number): void {
    this.buf = this.buf.subarray(n);
    if (this.buf.length === 0) {
      // Drop large capacity after a big head.
      this.buf = new Uint8Array(0);
    }
  }
}

export class Inbound {
  private readonly state = new Mutex(new State());
  private readonly data = new Notify();
  private readonly room = new Notify();
  private socket: Socket | undefined;
  private onData: ((chunk: Buffer) => void) | undefined;
  private onEnd: (() => void) | undefined;
  private onError: ((err: NodeJS.ErrnoException) => void) | undefined;

  static start(socket: Socket): Inbound {
    const inbound = new Inbound();
    inbound.attach(socket);
    return inbound;
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    const onData = (chunk: Buffer) => {
      const state = lockState(this.state);
      if (state.ended() || state.stop) {
        return;
      }
      // A data event has already consumed the entire chunk from the socket.
      // Retain it, then apply backpressure before Node delivers another one.
      const merged = new Uint8Array(state.buf.length + chunk.length);
      merged.set(state.buf);
      merged.set(chunk, state.buf.length);
      state.buf = merged;
      if (merged.length >= CAP) socket.pause();
      this.data.notifyWaiters();
      this.room.notifyOne();
    };
    const onEnd = () => {
      lockState(this.state).eof = true;
      this.data.notifyWaiters();
    };
    const onError = (err: NodeJS.ErrnoException) => {
      lockState(this.state).error = err;
      this.data.notifyWaiters();
    };
    this.onData = onData;
    this.onEnd = onEnd;
    this.onError = onError;
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.on('close', onEnd);
    this.pump(socket);
  }

  private async pump(socket: Socket): Promise<void> {
    for (;;) {
      await this.room.notified();
      const state = lockState(this.state);
      if (state.stop || state.ended()) {
        return;
      }
      if (state.buf.length < CAP) {
        socket.resume();
      } else {
        socket.pause();
      }
    }
  }

  lock(): State {
    return lockState(this.state);
  }

  consume(n: number): void {
    lockState(this.state).consume(n);
    this.room.notifyOne();
  }

  wakeReader(): void {
    this.room.notifyOne();
  }

  async peerEnded(socket: Socket): Promise<boolean> {
    // Match Rust inbound::peer_ended: peek the TCP peer. Ok(0) → ended,
    // WouldBlock → not ended, Ok(n) → wait for the reader to take those bytes.
    // Without MSG_PEEK, bytes already in `buf` were consumed from the socket
    // (peek would not see them). Only stream-buffered unread bytes (e.g. while
    // paused) mirror Ok(n); an empty readable buffer is WouldBlock — return
    // false instead of waiting forever for a peer that is only awaiting our
    // response (GET /health with Connection: close still open).
    for (let attempt = 0; attempt < PEEK_TRIES; attempt += 1) {
      const have = (() => {
        const state = lockState(this.state);
        if (state.ended()) {
          return -1;
        }
        if (state.buf.length >= CAP) {
          return -2;
        }
        return state.buf.length;
      })();
      if (have === -1) {
        return true;
      }
      if (have === -2) {
        return false;
      }
      if (socket.readableEnded || socket.destroyed) {
        return true;
      }
      if ((socket.readableLength ?? 0) === 0) {
        return false;
      }
      await this.waitUntil((state) => state.buf.length !== have || state.ended());
    }
    return false;
  }

  async waitUntil(check: (state: State) => boolean): Promise<void> {
    for (;;) {
      // Enable before the condition check so a notify between check and wait is not lost.
      const pending = this.data.notified();
      pending.enable();
      if (check(lockState(this.state))) {
        pending.cancel();
        return;
      }
      await pending;
    }
  }

  async waitForMore(have: number): Promise<void> {
    await this.waitUntil((state) => state.buf.length > have || state.ended());
  }

  async stop(): Promise<{ socket: Socket; buffered: Uint8Array } | undefined> {
    const socket = this.socket;
    if (socket === undefined) {
      return undefined;
    }
    lockState(this.state).stop = true;
    this.room.notifyOne();
    if (this.onData) {
      socket.off('data', this.onData);
    }
    if (this.onEnd) {
      socket.off('close', this.onEnd);
    }
    if (this.onError) {
      socket.off('error', this.onError);
    }
    const buffered = new Uint8Array(lockState(this.state).buf);
    lockState(this.state).buf = new Uint8Array(0);
    return { socket, buffered };
  }
}

function lockState(mutex: Mutex<State>): State {
  return mutex.lock().get();
}