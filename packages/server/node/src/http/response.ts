/** Response writer — Kestrel framing and head. */

import type { Socket } from 'node:net';
import type { Exchange } from './exchange.ts';
import { Framing, responseHeadBytes, sendWire } from './exchange.ts';
import { Headers, isFieldValue } from './headers.ts';

export enum WriteError {
  Closed = 'Closed',
  BodyNotAllowed = 'BodyNotAllowed',
  TooManyBytes = 'TooManyBytes',
  InvalidHeader = 'InvalidHeader',
  Io = 'Io',
}

export enum HijackError {
  Started = 'Started',
  Gone = 'Gone',
}

export interface Upgraded {
  socket: Socket;
  buffered: Uint8Array;
}

export class ResponseWriter {
  private readonly exchange: Exchange;
  private status = 200;
  private readonly headerBag = new Headers();
  private committed = false;

  constructor(exchange: Exchange) {
    this.exchange = exchange;
  }

  statusCode(): number {
    return this.status;
  }

  setStatus(status: number): void {
    if (!this.committed) {
      this.status = status;
    }
  }

  headers(): Headers {
    return this.headerBag;
  }

  headersMut(): Headers {
    return this.headerBag;
  }

  serverHeader(): string | undefined {
    const value = this.exchange.config.serverHeader;
    if (value === undefined || !isFieldValue(value)) {
      return undefined;
    }
    return value;
  }

  started(): boolean {
    return this.committed;
  }

  async start(status: number): Promise<void> {
    this.setStatus(status);
    await this.flush();
  }

  async flush(): Promise<void> {
    const guard = await this.exchange.wire.lock();
    await this.commit(guard.get());
    guard.release();
  }

  async write(bytes: Uint8Array): Promise<void> {
    const guard = await this.exchange.wire.lock();
    const wire = guard.get();
    await this.commit(wire);
    if (bytes.length === 0) {
      guard.release();
      return;
    }
  const framing = wire.framing;
    if (framing === Framing.None) {
      if (this.exchange.methodHead) {
        guard.release();
        return;
      }
      guard.release();
      throw WriteError.BodyNotAllowed;
    }
    if (typeof framing === 'object' && 'tag' in framing && framing.tag === 'Length') {
      if (bytes.length > framing.remaining) {
        guard.release();
        throw WriteError.TooManyBytes;
      }
      wire.framing = { tag: 'Length', remaining: framing.remaining - bytes.length };
      await sendWire(wire, Buffer.from(bytes));
      guard.release();
      return;
    }
    if (framing === Framing.Chunked) {
      const chunk = Buffer.concat([
        Buffer.from(`${bytes.length.toString(16)}\r\n`, 'utf8'),
        Buffer.from(bytes),
        Buffer.from('\r\n'),
      ]);
      await sendWire(wire, chunk);
      guard.release();
      return;
    }
    await sendWire(wire, Buffer.from(bytes));
    guard.release();
  }

  async hijack(): Promise<Upgraded> {
    const guard = await this.exchange.wire.lock();
    const wire = guard.get();
    if (wire.started || wire.hostOwned || wire.finished || wire.hijacked) {
      guard.release();
      throw HijackError.Started;
    }
    const socket = wire.socket;
    if (socket === undefined) {
      guard.release();
      throw HijackError.Gone;
    }
    wire.started = true;
    wire.hijacked = true;
    this.committed = true;
    guard.release();
    // The exchange now owns the socket for as long as its session lives, so
    // the connection must drop the request timeout it armed around the handler.
    this.exchange.hijacked.notifyWaiters();
    const stopped = await this.exchange.inbound.stop();
    if (stopped === undefined) {
      throw HijackError.Gone;
    }
    return { socket: stopped.socket, buffered: stopped.buffered };
  }

  dropState(): void {
    if (!this.committed) {
      this.exchange.left.lock().set([this.status, this.headerBag]);
    }
  }

  private async commit(wire: import('./exchange.ts').Wire): Promise<void> {
    if (wire.hostOwned || wire.finished || wire.hijacked) {
      throw WriteError.Closed;
    }
    if (this.committed) {
      return;
    }
    if (this.exchange.inbound.lock().ended()) {
      wire.hostOwned = true;
      wire.close = true;
      throw WriteError.Closed;
    }
    this.committed = true;
    wire.started = true;
    const built = responseHeadBytes(this.exchange, wire, this.status, this.headerBag, false);
    if ('refused' in built) {
      await sendWire(wire, built.refused);
      throw WriteError.InvalidHeader;
    }
    await sendWire(wire, built);
  }
}