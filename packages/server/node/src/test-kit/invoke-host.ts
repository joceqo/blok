import type { Socket } from 'node:net';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHostHandler } from '../host/app.ts';
import type { HostAppOptions } from '../host/options.ts';
import { RateLimiter } from '../host/rate-limit.ts';
import { DefaultBlockedPolicy, OutboundFetcher } from '../outbound/fetcher.ts';
import { Body, BodyState, FramingTag } from '../http/body.ts';
import { defaultConfig } from '../http/config.ts';
import { Deadline, Exchange, Framing, Limits, sendWire } from '../http/exchange.ts';
import { TargetForm, Version, type Head } from '../http/head.ts';
import { Headers } from '../http/headers.ts';
import { Inbound } from '../http/inbound.ts';
import { CancelToken, Extensions, makeRequest } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { AsyncMutex, Mutex, watchChannel } from '../http/sync.ts';
import { createCollectingSocket } from './collecting-socket.ts';
import { parseHttpResponse, type ParsedHttpResponse } from './parse-http-response.ts';

export interface InvokeHostRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export function defaultTestHostOptions(storageDirectory?: string): HostAppOptions {
  const directory = storageDirectory ?? mkdtempSync(join(tmpdir(), 'blok-node-fast-'));
  mkdirSync(directory, { recursive: true });
  return {
    version: 'dev',
    auth: 'none',
    secret: '',
    unfurlDisabled: false,
    unfurlEnabled: true,
    storageDirectory: directory,
    publicPath: '/',
    publicUrl: 'http://127.0.0.1:4000/',
    maxUploadBytes: 30_000_000,
    collabEnabled: false,
    docEndpoint: '',
    allowedOrigins: [],
    fileBytesEnabled: false,
    fileBytesMaxBytes: 100 << 20,
    filesCors: false,
    fetcher: new OutboundFetcher(new DefaultBlockedPolicy()),
    rateLimiter: new RateLimiter(0),
  };
}

async function runHandlerOnce(
  handler: ReturnType<typeof createHostHandler>,
  head: Head,
  socket: Socket,
  body?: Uint8Array,
): Promise<void> {
  const config = defaultConfig();
  const inbound = Inbound.start(socket);
  if (body !== undefined && body.length > 0) {
    socket.push(Buffer.from(body));
  }
  const { sender: cancel, receiver: cancelReceiver } = watchChannel(false);
  const { sender: expired, receiver: expiredReceiver } = watchChannel(false);
  const limits = new Mutex(new Limits(config.maxRequestBody, undefined));
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
    body: new AsyncMutex(
      new BodyState(
        (() => {
          const lengthRaw = head.headers.get('content-length');
          if (lengthRaw !== undefined) {
            const length = Number(lengthRaw);
            if (Number.isFinite(length) && length > 0) {
              return { tag: FramingTag.Length, remaining: length };
            }
          }
          return { tag: FramingTag.Empty };
        })(),
        0,
        head.headers.len(),
      ),
    ),
    limits,
    deadline: new Mutex(new Deadline()),
    left: new Mutex(undefined),
    active: new Mutex(() => {}),
    methodHead: head.method === 'HEAD',
    version: head.version,
    requestClose: true,
    keepAlive10: false,
    expectsContinue: false,
    stopping: { load: () => false },
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
  await handler(request, response);
  response.dropState();
  const wireGuard = await exchange.wire.lock();
  const wire = wireGuard.get();
  if (wire.framing === Framing.Chunked) {
    await sendWire(wire, Buffer.from('0\r\n\r\n'));
  }
  wire.finished = true;
  wireGuard.release();
}

function buildHead(input: InvokeHostRequest): Head {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers.set(name, value);
  }
  if (input.body !== undefined) {
    const body = typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body;
    headers.set('Content-Length', String(body.length));
  }
  return {
    method: input.method,
    target: input.path,
    form: TargetForm.Origin,
    path: input.path,
    query: '',
    version: Version.Http11,
    headers,
    headerBytes: 0,
  };
}

/** Fast tier: handler in one process, no `blok-server` spawn. */
export async function invokeHost(
  options: HostAppOptions,
  input: InvokeHostRequest,
): Promise<ParsedHttpResponse> {
  const handler = createHostHandler(options);
  const { socket, drain } = createCollectingSocket();
  const body = input.body === undefined
    ? undefined
    : typeof input.body === 'string'
      ? new TextEncoder().encode(input.body)
      : input.body;
  await runHandlerOnce(handler, buildHead(input), socket, body);
  return parseHttpResponse(drain());
}