/** What one request shares between its handler and its connection. */

import type { Socket } from 'node:net';
import { AsyncMutex, Mutex, Notify, lock, type WatchReceiver, type WatchSender } from './sync.ts';
import type { Config } from './config.ts';
import type { BodyState } from './body.ts';
import { Headers } from './headers.ts';
import type { Inbound } from './inbound.ts';
import { Version } from './head.ts';
import { httpDate, reasonPhrase } from './wire.ts';

export enum Framing {
  None = 'None',
  Length = 'Length',
  Chunked = 'Chunked',
  Close = 'Close',
}

export interface Wire {
  socket: Socket | undefined;
  started: boolean;
  framing: Framing | { tag: 'Length'; remaining: number };
  hostOwned: boolean;
  pendingTimeout: boolean;
  finished: boolean;
  close: boolean;
  hijacked: boolean;
  expired: WatchReceiver<boolean>;
  inbound: Inbound;
}

function framingLength(framing: Wire['framing']): number | undefined {
  if (typeof framing === 'object' && 'tag' in framing && framing.tag === 'Length') {
    return framing.remaining;
  }
  return undefined;
}

export class Deadline {
  lifted = false;
  expired = false;
  body: number | undefined;
}

export class Limits {
  limit: number;
  routeSet = false;
  started = false;
  length: number | undefined;

  constructor(limit: number, length: number | undefined) {
    this.limit = limit;
    this.length = length;
  }
}

export class Exchange {
  config: Config;
  inbound: Inbound;
  wire: AsyncMutex<Wire>;
  body: AsyncMutex<BodyState>;
  limits: Mutex<Limits>;
  deadline: Mutex<Deadline>;
  deadlineChanged = new Notify();
  hijacked = new Notify();
  cancel: WatchSender<boolean>;
  expired: WatchSender<boolean>;
  left: Mutex<[number, Headers] | undefined>;
  active: Mutex<unknown>;
  methodHead: boolean;
  version: Version;
  requestClose: boolean;
  keepAlive10: boolean;
  expectsContinue: boolean;
  stopping: { load: () => boolean };

  constructor(fields: Omit<
    Exchange,
    | 'cancel'
    | 'refuse'
    | 'refuseUnhandled'
    | 'bodyDeadline'
    | 'cancelRequest'
    | 'stoppingNow'
    | 'deadlineChanged'
    | 'hijacked'
  > & {
    cancel: WatchSender<boolean>;
    expired: WatchSender<boolean>;
  }) {
    Object.assign(this, fields);
    this.deadlineChanged = new Notify();
    this.hijacked = new Notify();
  }

  cancelRequest(): void {
    this.cancel.sendReplace(true);
  }

  stoppingNow(): boolean {
    return this.stopping.load();
  }

  bodyDeadline(): number | undefined {
    return lock(this.deadline).get().body;
  }

  async refuse(status: number): Promise<void> {
    const wireGuard = await this.wire.lock();
    const wire = wireGuard.get();
    wire.close = true;
    if (wire.started || wire.hijacked || wire.finished) {
      wireGuard.release();
      return;
    }
    wire.started = true;
    wire.hostOwned = true;
    const answer = bareAnswer(this.config, { tag: 'Status', status });
    await sendWire(wire, answer);
    wireGuard.release();
  }

  async refuseUnhandled(): Promise<void> {
    const wireGuard = await this.wire.lock();
    const wire = wireGuard.get();
    wire.close = true;
    if (wire.started || wire.hijacked || wire.finished) {
      wireGuard.release();
      return;
    }
    wire.started = true;
    wire.hostOwned = true;
    const connection = this.requestClose ? 'Connection: close\r\n' : '';
    let head = `HTTP/1.1 500 ${reasonPhrase(500)}\r\nContent-Length: 0\r\n${connection}Date: ${httpDate(Date.now())}\r\n`;
    if (this.config.serverHeader !== undefined) {
      head += `Server: ${this.config.serverHeader}\r\n`;
    }
    head += '\r\n';
    await sendWire(wire, Buffer.from(head, 'utf8'));
    wireGuard.release();
  }
}

export type Answer =
  | { tag: 'Status'; status: number }
  | { tag: 'GoAway' }
  | { tag: 'MethodNotAllowed'; allow: string };

export function bareAnswer(config: Config, answer: Answer): Buffer {
  if (answer.tag === 'GoAway') {
    return Buffer.from([
      0x00, 0x00, 0x08, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0d,
    ]);
  }
  const status = answer.tag === 'Status' ? answer.status : 405;
  const allow = answer.tag === 'MethodNotAllowed' ? answer.allow : undefined;
  let head = `HTTP/1.1 ${status} ${reasonPhrase(status)}\r\nContent-Length: 0\r\nConnection: close\r\nDate: ${httpDate(Date.now())}\r\n`;
  if (config.serverHeader !== undefined) {
    head += `Server: ${config.serverHeader}\r\n`;
  }
  if (allow !== undefined) {
    head += `Allow: ${allow}\r\n`;
  }
  head += '\r\n';
  return Buffer.from(head, 'utf8');
}

export async function sendWire(wire: Wire, bytes: Buffer): Promise<void> {
  const socket = wire.socket;
  if (socket === undefined) {
    throw new Error('NotConnected');
  }
  if (await wire.inbound.peerEnded(socket)) {
    wire.close = true;
    throw new Error('BrokenPipe');
  }
  const expired = wire.expired.borrow();
  if (expired) {
    wire.close = true;
    socket.destroy();
    throw new Error('TimedOut');
  }
  await new Promise<void>((resolve, reject) => {
    socket.write(bytes, (err) => {
      if (err) {
        wire.close = true;
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export const RST_AVOIDANCE = 500;

export function responseHeadBytes(
  exchange: Exchange,
  wire: Wire,
  status: number,
  headers: Headers,
  finished: boolean,
): Buffer | { refused: Buffer } {
  const lengths = [...headers.getAll('content-length')];
  const badLength =
    lengths.length > 1 || lengths.some((value) => value.trim().length > 0 && !/^\d+$/.test(value.trim()));
  if (badLength || [...headers.iter()].some(([name, value]) => !validName(name) || !isFieldValueHead(value))) {
    const refused = new Headers();
    refused.add('Content-Length', '0');
    wire.hostOwned = true;
    return { refused: buildHead(exchange, wire, 500, refused, finished) };
  }
  return buildHead(exchange, wire, status, headers, finished);
}

import { isFieldValue as isFieldValueHead } from './headers.ts';
import { isTokenByte } from './head.ts';

function validName(name: string): boolean {
  return name.length > 0 && [...name].every((ch) => isTokenByte(ch.charCodeAt(0)));
}

function buildHead(
  exchange: Exchange,
  wire: Wire,
  status: number,
  headers: Headers,
  finished: boolean,
): Buffer {
  const lengthText = headers.get('content-length');
  const length = lengthText !== undefined ? Number(lengthText.trim()) : undefined;
  let autoLength: number | undefined;
  let framing: Wire['framing'];
  const bodyAllowed = !(status >= 100 && status < 200) && status !== 204 && status !== 304;
  if (!bodyAllowed) {
    framing = Framing.None;
  } else if (length !== undefined && Number.isFinite(length)) {
    framing = exchange.methodHead ? Framing.None : { tag: 'Length', remaining: length };
  } else if (exchange.methodHead) {
    framing = Framing.None;
  } else if (finished) {
    autoLength = 0;
    framing = { tag: 'Length', remaining: 0 };
  } else if (exchange.version === Version.Http11) {
    framing = Framing.Chunked;
  } else {
    framing = Framing.Close;
  }
  wire.framing = framing;
  const sized = framing === Framing.None || (typeof framing === 'object' && framing.tag === 'Length');
  const close =
    wire.close
    || exchange.requestClose
    || exchange.stoppingNow()
    || framing === Framing.Close
    || headers.hasToken('connection', 'close')
    || (exchange.version === Version.Http10 && !(exchange.keepAlive10 && sized));
  wire.close = close;
  let head = `HTTP/1.1 ${status} ${reasonPhrase(status)}\r\n`;
  const line = (name: string, value: string) => {
    head += `${name}: ${value}\r\n`;
  };
  const cl = headers.get('content-length');
  if (cl !== undefined) {
    line('Content-Length', cl);
  } else if (autoLength !== undefined) {
    line('Content-Length', String(autoLength));
  }
  const connection = headers.get('connection');
  if (connection !== undefined) {
    line('Connection', connection);
  } else if (close) {
    line('Connection', 'close');
  } else if (exchange.version === Version.Http10) {
    line('Connection', 'keep-alive');
  }
  for (const value of headers.getAll('content-type')) {
    line('Content-Type', value);
  }
  const date = headers.get('date');
  line('Date', date ?? httpDate(Date.now()));
  if (exchange.config.serverHeader !== undefined && !headers.contains('server') && isFieldValueHead(exchange.config.serverHeader)) {
    line('Server', exchange.config.serverHeader);
  }
  if (framing === Framing.Chunked) {
    line('Transfer-Encoding', 'chunked');
  }
  for (const [name, value] of headers.iter()) {
    const own = ['content-length', 'connection', 'content-type', 'date', 'transfer-encoding'];
    if (own.some((o) => name.toLowerCase() === o)) {
      continue;
    }
    line(name, value);
  }
  head += '\r\n';
  return Buffer.from(head, 'utf8');
}

export { framingLength };