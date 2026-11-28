import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import type { Server as NetServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Doc, encodeStateVector } from 'yjs';

import { decode, encode } from '../../../../../src/components/modules/collaboration/sync-wire.ts';

import { createHostApp } from './app.ts';
import type { HostAppOptions } from './options.ts';
import { defaultConfig } from '../http/config.ts';
import { listen, parseIp } from '../http/listen.ts';
import { Server } from '../http/server.ts';
import { defaultTestHostOptions } from '../test-kit/invoke-host.ts';

const V2 = 'blok-sync.v2';
const V1 = 'blok-sync.v1';
const CONTROL_TYPE = 100;
const DRAINING_CLOSE = 1001;
const RESET_CLOSE = 4409;
const ORIGIN = 'https://app.example.test';
const SECRET = 's'.repeat(32);

interface RunningHost {
  baseUrl: string;
  wsUrl: string;
  stop(): Promise<void>;
}

async function startHost(overrides: Partial<HostAppOptions>): Promise<RunningHost> {
  const servers: NetServer[] = await listen('127.0.0.1:0', parseIp);
  const app = createHostApp({ ...defaultTestHostOptions(), ...overrides });
  const http = new Server(app.handler, defaultConfig());
  const serving = http.serveStd(servers);
  const address = servers[0]?.address();
  if (address === undefined || address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  const authority = `127.0.0.1:${address.port}`;
  return {
    baseUrl: `http://${authority}`,
    wsUrl: `ws://${authority}`,
    stop: async () => {
      await app.close();
      await http.shutdown(5_000);
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      await serving;
    },
  };
}

interface OpenSocket {
  closed: { code: number; reason: string } | null;
  frames: Uint8Array[];
  protocol: string;
  socket: WebSocket;
}

/** Resolves on the handshake, so a refusal BEFORE the 101 rejects and a refusal after it does not. */
function openSocket(host: RunningHost, doc: string, ticket?: string): Promise<OpenSocket> {
  const url = `${host.wsUrl}/sync/${encodeURIComponent(doc)}`;
  const protocols = ticket === undefined ? [V2, V1] : [V2, V1, ticket];
  // Node's WebSocket sends no Origin of its own; undici takes one through the
  // init object the DOM typing does not know about.
  const socket = ticket === undefined
    ? new WebSocket(url, protocols)
    : new WebSocket(url, { protocols, headers: { Origin: ORIGIN } } as unknown as string[]);
  const frames: Uint8Array[] = [];
  let closed: { code: number; reason: string } | null = null;

  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) {
      frames.push(new Uint8Array(event.data));
    }
  });
  socket.addEventListener('close', (event: CloseEvent) => {
    closed = { code: event.code, reason: event.reason };
  });

  const handle: OpenSocket = {
    get closed() {
      return closed;
    },
    frames,
    get protocol() {
      return socket.protocol;
    },
    socket,
  };

  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(handle), { once: true });
    socket.addEventListener('error', () => reject(new Error(`Could not open a sync socket to ${url}`)), { once: true });
  });
}

/** The upgrade as a plain HTTP exchange, so a refusal's status and body can be read. */
function upgradeStatus(
  host: RunningHost,
  doc: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; protocol: string | undefined }> {
  return new Promise((resolve, reject) => {
    const call = httpRequest(`${host.baseUrl}/sync/${encodeURIComponent(doc)}`, {
      // A one-off agent: a pooled keep-alive socket would hold the host open
      // past the drain this suite measures.
      agent: false,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });
    call.once('error', reject);
    call.once('upgrade', (message, socket) => {
      socket.destroy();
      resolve({
        status: message.statusCode ?? 0,
        body: '',
        protocol: message.headers['sec-websocket-protocol'],
      });
    });
    call.once('response', (message) => {
      const chunks: Buffer[] = [];
      message.on('data', (chunk: Buffer) => chunks.push(chunk));
      message.once('end', () => resolve({
        status: message.statusCode ?? 0,
        body: Buffer.concat(chunks).toString(),
        protocol: message.headers['sec-websocket-protocol'],
      }));
    });
    call.end();
  });
}

/** `[100][varuint len]{"epoch":N,"format":N,"lineage":"<32 hex>"}`. */
function controlLineage(frame: Uint8Array): string {
  let at = 1;
  let length = 0;
  let shift = 0;
  for (;;) {
    const byte = frame[at] ?? 0;
    at += 1;
    length |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  const control = JSON.parse(new TextDecoder().decode(frame.subarray(at, at + length))) as { lineage: string };
  return control.lineage;
}

/** One binary frame, masked the way a client must mask everything it sends. */
function clientFrame(payload: Uint8Array): Buffer {
  if (payload.length >= 126) {
    throw new Error('This helper writes only the short frames the first exchange needs');
  }
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (const [at, byte] of masked.entries()) {
    masked[at] = byte ^ (mask[at % 4] ?? 0);
  }
  return Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, masked]);
}

/**
 * Pulls whole binary frames out of what the host has written, and hands back
 * what is left over. The room's own frames are short, so only the one-byte
 * length is read.
 */
function readFrames(buffer: Buffer, frames: Uint8Array[]): Buffer {
  const length = (buffer[1] ?? 0) & 0x7f;
  if (buffer.length < 2 + length) {
    return buffer;
  }
  if (((buffer[0] ?? 0) & 0x0f) === 0x02) {
    frames.push(new Uint8Array(buffer.subarray(2, 2 + length)));
  }
  return readFrames(buffer.subarray(2 + length), frames);
}

/**
 * Upgrades by hand and hands the socket back in the turn the 101 is read, so a
 * frame written on it reaches the host while it is still opening the room.
 */
function handshake(host: RunningHost, doc: string): Promise<{ frames: Uint8Array[]; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const call = httpRequest(`${host.baseUrl}/sync/${encodeURIComponent(doc)}`, {
      agent: false,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64'),
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Protocol': `${V2}, ${V1}`,
      },
    });
    call.once('error', reject);
    call.once('upgrade', (_message, socket, head) => {
      const frames: Uint8Array[] = [];
      const carry = { rest: readFrames(Buffer.from(head), frames) };
      socket.on('data', (chunk: Buffer) => {
        carry.rest = readFrames(Buffer.concat([carry.rest, chunk]), frames);
      });
      resolve({ frames, socket });
    });
    call.end();
  });
}

function post(host: RunningHost, path: string): Promise<{ status: number; body: string; protocol: string | undefined }> {
  return new Promise((resolve, reject) => {
    const call = httpRequest(`${host.baseUrl}${path}`, { agent: false, method: 'POST' });
    call.once('error', reject);
    call.once('response', (message) => {
      const chunks: Buffer[] = [];
      message.on('data', (chunk: Buffer) => chunks.push(chunk));
      message.once('end', () => resolve({
        status: message.statusCode ?? 0,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    call.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(ready: () => boolean, describe: () => string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${describe()}`);
    }
    await delay(10);
  }
}

function ticketFor(doc: string, user: string, write: boolean): string {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    user,
    doc,
    write,
    exp: Math.ceil(Date.now() / 1000) + 60,
  })).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${createHmac('sha256', SECRET).update(signed).digest('base64url')}`;
}

describe('@fast the sync route hosts the collaboration room', () => {
  let endpoint: HttpServer;
  let docEndpoint = '';
  let collabDirectory = '';
  const storageDirectory = defaultTestHostOptions().storageDirectory;

  beforeAll(async () => {
    // The seed source: a document the host has never stored answers `null`.
    endpoint = createServer((_, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('null');
    });
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    const address = endpoint.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP address');
    }
    docEndpoint = `http://127.0.0.1:${address.port}/docs`;
    collabDirectory = await mkdtemp(join(tmpdir(), 'blok-sync-upgrade-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(collabDirectory, { force: true, recursive: true });
    await rm(storageDirectory, { force: true, recursive: true });
  });

  const journalling = (): Partial<HostAppOptions> => ({
    collabEnabled: true,
    collabJournal: true,
    collabDirectory,
    docEndpoint,
  });

  it('completes the upgrade, selects blok-sync.v2 and opens the room', async () => {
    const host = await startHost(journalling());
    try {
      const socket = await openSocket(host, 'upgrade-doc');

      expect(socket.protocol).toBe(V2);
      await waitFor(() => socket.frames.length > 0, () => 'the room\'s first frame');
      // Section 4: the room announces itself with a type-100 control frame.
      expect(socket.frames[0]?.[0]).toBe(CONTROL_TYPE);
      expect(socket.closed).toBeNull();
      socket.socket.close();

      // The journal the conformance suite reads lives under the document's own hash.
      const directory = join(collabDirectory, `${createHash('sha256').update('upgrade-doc').digest('hex')}.journal`);
      expect((await stat(directory)).isDirectory()).toBe(true);
    } finally {
      await host.stop();
    }
  });

  it('answers a syncStep1 written in the same turn as the handshake', async () => {
    const host = await startHost(journalling());
    // What the browser client does: it sends its syncStep1 from `onopen` and
    // never sends it again. The host answers the handshake before it opens the
    // room, so this frame lands in that gap and must survive it.
    const opened = await handshake(host, 'eager-doc');
    try {
      opened.socket.write(clientFrame(encode({ type: 'syncStep1', stateVector: encodeStateVector(new Doc()) })));

      await waitFor(
        () => opened.frames.some((frame) => decode(frame).type === 'syncStep2'),
        () => 'the room\'s answer to the first syncStep1',
        3_000,
      );
    } finally {
      opened.socket.destroy();
      await host.stop();
    }
  });

  it('still asks for an upgrade on a plain GET', async () => {
    const host = await startHost(journalling());
    try {
      const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const call = httpRequest(`${host.baseUrl}/sync/plain-doc`, { agent: false, method: 'GET' });
        call.once('error', reject);
        call.once('response', (message) => {
          const chunks: Buffer[] = [];
          message.on('data', (chunk: Buffer) => chunks.push(chunk));
          message.once('end', () => resolve({
            status: message.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }));
        });
        call.end();
      });

      expect(answer.status).toBe(426);
      expect(answer.body).toBe('WebSocket upgrade required\n');
    } finally {
      await host.stop();
    }
  });

  it('serves an upgrade that offers no blok-sync subprotocol, echoing none back', async () => {
    const host = await startHost(journalling());
    try {
      // Nothing to read out of the offers but a pass, and a host without
      // authentication wants none: the socket is served without a protocol.
      const answer = await upgradeStatus(host, 'no-protocol', { 'Sec-WebSocket-Protocol': 'chat' });

      expect(answer.status).toBe(101);
      expect(answer.protocol).toBeUndefined();
    } finally {
      await host.stop();
    }
  });

  it('refuses an upgrade that offers no blok-sync.v1 to a ticket host', async () => {
    const host = await startHost({ ...journalling(), auth: 'ticket', secret: SECRET, allowedOrigins: [ORIGIN] });
    try {
      // The pass rides in the offer list, and only that protocol says so.
      const answer = await upgradeStatus(host, 'no-protocol', {
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': ticketFor('no-protocol', 'u1', true),
      });

      expect(answer.status).toBe(400);
      expect(answer.body).toBe('blok-sync.v1 must be offered in Sec-WebSocket-Protocol\n');
    } finally {
      await host.stop();
    }
  });

  it('reads the pass out of the subprotocol and closes one issued for another document 4401', async () => {
    const host = await startHost({
      ...journalling(),
      auth: 'ticket',
      secret: SECRET,
      allowedOrigins: [ORIGIN],
    });
    try {
      // The handshake is answered whatever the pass says: a browser socket
      // never sees the body of a refusal, only a close code and its reason.
      const refused = await openSocket(host, 'mine', ticketFor('other', 'u1', true));

      await waitFor(() => refused.closed !== null, () => 'the refusal close');
      expect(refused.closed).toEqual({ code: 4401, reason: 'pass is for another document' });

      const admitted = await openSocket(host, 'mine', ticketFor('mine', 'u1', true));

      expect(admitted.protocol).toBe(V2);
      await waitFor(() => admitted.frames.length > 0, () => 'the room\'s first frame');
      admitted.socket.close();
    } finally {
      await host.stop();
    }
  });

  it('refuses an upgrade from an origin the host does not allow', async () => {
    const host = await startHost({
      ...journalling(),
      auth: 'ticket',
      secret: SECRET,
      allowedOrigins: [ORIGIN],
    });
    try {
      const refused = await upgradeStatus(host, 'guarded', {
        Origin: 'https://elsewhere.test',
        'Sec-WebSocket-Protocol': `${V2}, ${ticketFor('guarded', 'u1', true)}`,
      });

      expect(refused.status).toBe(403);
      expect(refused.body).toBe('origin not allowed\n');
    } finally {
      await host.stop();
    }
  });

  it('serves an upgrade without a journal, and never selects blok-sync.v2', async () => {
    const host = await startHost({ collabEnabled: true, collabDirectory, docEndpoint });
    try {
      // v2 is what a journal lets a room promise. Without one the host holds
      // rooms all the same, and answers v1.
      const answer = await upgradeStatus(host, 'no-journal', { 'Sec-WebSocket-Protocol': `${V2}, ${V1}` });

      expect(answer.status).toBe(101);
      expect(answer.protocol).toBe(V1);
    } finally {
      await host.stop();
    }
  });

  it('publishes a new lineage on reset and closes every member with 4409', async () => {
    const host = await startHost(journalling());
    try {
      const socket = await openSocket(host, 'reset-doc');
      await waitFor(() => socket.frames.length > 0, () => 'the room\'s control frame');
      const before = controlLineage(socket.frames[0] ?? new Uint8Array());

      const answer = await post(host, '/sync/reset-doc/reset');

      expect(answer.status, answer.body).toBe(204);
      await waitFor(() => socket.closed !== null, () => 'the reset close');
      expect(socket.closed?.code).toBe(RESET_CLOSE);

      const rejoined = await openSocket(host, 'reset-doc');

      await waitFor(() => rejoined.frames.length > 0, () => 'the new generation\'s control frame');
      expect(controlLineage(rejoined.frames[0] ?? new Uint8Array())).not.toBe(before);
      rejoined.socket.close();
    } finally {
      await host.stop();
    }
  });

  it('closes every member with 1001 when the host drains', async () => {
    const host = await startHost(journalling());
    const socket = await openSocket(host, 'draining-doc');

    await waitFor(() => socket.frames.length > 0, () => 'the room\'s first frame');
    await host.stop();
    await waitFor(() => socket.closed !== null, () => 'the drain\'s close');
    expect(socket.closed?.code).toBe(DRAINING_CLOSE);
  });

  /**
   * A dropped socket is what a person experiences as "it disconnected on its
   * own", and the close code is the only thing that says why. It reaches the
   * client and nowhere else, so until it is written down the host has no
   * answer to the one question it will be asked.
   */
  it('keeps the code and reason of a socket it refused, and the document', async () => {
    const logged: string[] = [];
    const host = await startHost({
      ...journalling(),
      auth: 'ticket',
      secret: SECRET,
      allowedOrigins: [ORIGIN],
      collabLog: (message) => logged.push(message),
    });
    try {
      const refused = await openSocket(host, 'logged-doc', ticketFor('other', 'u1', true));

      await waitFor(() => refused.closed !== null, () => 'the refusal close');
      expect(logged).toContain(
        'collab: socket closed code=4401 reason="pass is for another document" doc="logged-doc"',
      );
    } finally {
      await host.stop();
    }
  });

  it('names the member whose socket it dropped, once the pass said who that was', async () => {
    const logged: string[] = [];
    const host = await startHost({
      ...journalling(),
      auth: 'ticket',
      secret: SECRET,
      allowedOrigins: [ORIGIN],
      collabLog: (message) => logged.push(message),
    });
    const socket = await openSocket(host, 'drain-log-doc', ticketFor('drain-log-doc', 'u-42', true));

    await waitFor(() => socket.frames.length > 0, () => 'the room\'s first frame');
    await host.stop();
    await waitFor(() => socket.closed !== null, () => 'the drain\'s close');
    expect(logged).toContain(
      'collab: socket closed code=1001 reason="host draining" doc="drain-log-doc" actor="u-42"',
    );
  });

  it('says nothing when a member closes its own socket', async () => {
    const logged: string[] = [];
    const host = await startHost({ ...journalling(), collabLog: (message) => logged.push(message) });
    try {
      const socket = await openSocket(host, 'quiet-doc');

      await waitFor(() => socket.frames.length > 0, () => 'the room\'s first frame');
      socket.socket.close();
      await waitFor(() => socket.closed !== null, () => 'the socket to settle');
      expect(logged).toEqual([]);
    } finally {
      await host.stop();
    }
  });
});
