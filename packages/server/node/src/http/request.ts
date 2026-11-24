/** The request a handler gets. */

import type { Socket } from 'node:net';
import type { Body } from './body.ts';
import type { Exchange } from './exchange.ts';
import { lock } from './sync.ts';
import type { TargetForm, Version } from './head.ts';
import { finalCodingIsChunked } from './head.ts';
import type { Headers } from './headers.ts';
import type { WatchReceiver } from './sync.ts';

export class CancelToken {
  constructor(
    private readonly receiver: WatchReceiver<boolean>,
    private readonly owner?: WatchSender<boolean>,
  ) {}

  static fromReceiver(receiver: WatchReceiver<boolean>): CancelToken {
    return new CancelToken(receiver);
  }

  static never(): CancelToken {
    const { sender, receiver } = watchChannel(false);
    return new CancelToken(receiver, sender);
  }

  isCancelled(): boolean {
    return this.receiver.borrow();
  }

  async cancelled(): Promise<void> {
    await this.receiver.waitFor((v) => v);
  }
}

import { watchChannel, type WatchSender } from './sync.ts';

export class Extensions {
  private readonly map = new Map<string, unknown>();

  insert<T>(key: string, value: T): T | undefined {
    const old = this.map.get(key);
    this.map.set(key, value);
    return old as T | undefined;
  }

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
}

export interface Request {
  method(): string;
  target(): string;
  targetForm(): TargetForm;
  path(): string;
  setPath(path: string): void;
  query(): string;
  version(): Version;
  headers(): Headers;
  headersMut(): Headers;
  remoteAddr(): Socket['remoteAddress'];
  remotePort(): number | undefined;
  localAddr(): Socket['localAddress'];
  localPort(): number | undefined;
  contentLength(): number | undefined;
  isChunked(): boolean;
  takeBody(): Body | undefined;
  bodyMut(): Body | undefined;
  cancelToken(): CancelToken;
  isCancelled(): boolean;
  liftTimeout(): boolean;
  setBodyLimit(limit: number): void;
}

export function makeRequest(fields: {
  method: string;
  target: string;
  form: TargetForm;
  path: string;
  query: string;
  version: Version;
  headers: Headers;
  remoteAddr: string | undefined;
  remotePort: number | undefined;
  localAddr: string | undefined;
  localPort: number | undefined;
  body: Body | undefined;
  cancel: CancelToken;
  exchange: Exchange;
  extensions?: Extensions;
}): Request {
  let path = fields.path;
  let body = fields.body;
  const headers = fields.headers;
  return {
    method: () => fields.method,
    target: () => fields.target,
    targetForm: () => fields.form,
    path: () => path,
    setPath: (next) => {
      path = next;
    },
    query: () => fields.query,
    version: () => fields.version,
    headers: () => headers,
    headersMut: () => headers,
    remoteAddr: () => fields.remoteAddr,
    remotePort: () => fields.remotePort,
    localAddr: () => fields.localAddr,
    localPort: () => fields.localPort,
    contentLength: () => fields.exchange.limits.lock().get().length,
    isChunked: () => finalCodingIsChunked(headers),
    takeBody: () => {
      const taken = body;
      body = undefined;
      return taken;
    },
    bodyMut: () => body,
    cancelToken: () => fields.cancel,
    isCancelled: () => fields.cancel.isCancelled(),
    liftTimeout: () => {
      const deadline = lock(fields.exchange.deadline).get();
      if (deadline.expired) {
        return false;
      }
      deadline.lifted = true;
      const hasBody = finalCodingIsChunked(headers) || (fields.exchange.limits.lock().get().length ?? 0) > 0;
      if (!hasBody) {
        deadline.body = undefined;
      }
      fields.exchange.deadlineChanged.notifyOne();
      return true;
    },
    setBodyLimit: (limit) => {
      const limits = fields.exchange.limits.lock().get();
      if (!limits.started) {
        limits.limit = limit;
        limits.routeSet = true;
      }
    },
  };
}