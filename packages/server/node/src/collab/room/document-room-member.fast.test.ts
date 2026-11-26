import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { decode, encode } from '../../../../../../src/components/modules/collaboration/sync-wire.ts';
import { initializePage, newBaseline, pageDirectory } from './page-seed.ts';
import { seedUpdate } from './page-document.ts';
import { openDocumentRoom } from './document-room.ts';
import type { RoomIdentity } from './preview.ts';

/**
 * One member's session: what the room tells it the moment it joins, and what
 * gets it expelled. The room is driven through `connect` with a socket of
 * this file's own — the join frames are written before the member has said
 * anything at all, and the frames that expel it need no sync first.
 */
const origin = 'http://localhost';
const editor: RoomIdentity = { id: 'editor', write: true };

let root: string;
let room: Awaited<ReturnType<typeof openDocumentRoom>>;

interface Socket {
  /** Every frame the room wrote to this member, in order. */
  sent: ReturnType<typeof decode>[];
  handlers: Map<string, (...args: unknown[]) => void>;
  protocol: string;
  readyState: number;
  bufferedAmount: number;
  /** The close the room asked for, once it has asked for one. */
  closed?: { code: number; reason: string };
  send(data: Uint8Array): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
}

/**
 * A member's socket, as much of one as the room reads. `connect` wants an
 * open socket it can write frames and listeners onto; nothing here goes near
 * a real handshake, so the cast is the whole of the pretence.
 */
function fakeSocket(protocol: string): Socket {
  const socket: Socket = {
    sent: [],
    handlers: new Map(),
    protocol,
    // ws.OPEN; the room compares against it before every write.
    readyState: 1,
    bufferedAmount: 0,
    send: (data) => { socket.sent.push(decode(data)); },
    on: (event, handler) => { socket.handlers.set(event, handler); },
    close: (code = 1000, reason = '') => {
      socket.closed ??= { code, reason };
      socket.readyState = 3;
    },
    terminate: () => { socket.readyState = 3; },
    ping: () => {},
  };

  return socket;
}

const asWebSocket = (socket: Socket): WebSocket => socket as unknown as WebSocket;

const kinds = (socket: Socket): string[] => socket.sent.map((frame) => frame.type);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blok-room-join-'));
  const seed = seedUpdate({ blocks: [{ id: 'a', type: 'paragraph', data: { text: 'seed' } }] });
  await initializePage(root, 'page-1', newBaseline(seed), '{}', async () => {});
  room = await openDocumentRoom({
    directory: pageDirectory(root, 'page-1'),
    documentId: 'page-1',
    allowedOrigins: new Set([origin]),
    authorize: async (token) => (token === 'editor' ? editor : null),
  });
});

afterEach(async () => {
  await room?.close();
  await rm(root, { recursive: true, force: true });
});

it('tells a joining member who is here, even when nobody is', async () => {
  const joining = fakeSocket('blok-sync.v2');

  room.connect(asWebSocket(joining), 'editor', editor);

  // Sent even when empty: a reconnect has to overwrite the map the client
  // still holds from its last session.
  expect(kinds(joining)).toContain('identities');
});

it('asks the members already here to announce themselves again when one joins', async () => {
  const first = fakeSocket('blok-sync.v2');

  room.connect(asWebSocket(first), 'editor', editor);
  first.sent.length = 0;

  const second = fakeSocket('blok-sync.v2');

  room.connect(asWebSocket(second), 'editor', editor);

  // No y-websocket client ever sends queryAwareness of its own, so without
  // this a late joiner never learns that the members before it exist.
  expect(kinds(first)).toContain('queryAwareness');
  expect(kinds(second)).not.toContain('queryAwareness');
});

it('keeps control and limits for a member that negotiated a sub-protocol', async () => {
  const spoken = fakeSocket('blok-sync.v2');
  const bare = fakeSocket('');

  room.connect(asWebSocket(spoken), 'editor', editor);
  room.connect(asWebSocket(bare), 'editor', editor);

  expect(kinds(spoken).slice(0, 2)).toEqual(['control', 'limits']);
  expect(kinds(bare)).not.toContain('control');
  expect(kinds(bare)).not.toContain('limits');
});

/** One frame written by this member, through the path the socket listener takes. */
function speak(socket: Socket, frame: Parameters<typeof encode>[0]): void {
  socket.handlers.get('message')?.(Buffer.from(encode(frame)), true);
}

/** An awareness update claiming `clients` and carrying none of them. */
const claiming = (clients: number): Uint8Array => {
  const bytes: number[] = [];

  for (let rest = clients; ; rest >>>= 7) {
    if (rest < 0x80) { bytes.push(rest); break; }
    bytes.push((rest & 0x7f) | 0x80);
  }

  return Uint8Array.from(bytes);
};

const awareness = (clients: number) => ({ type: 'awareness', update: claiming(clients) } as const);

/** The room reads a member's frames off its own queue, so a test waits on it. */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 500; turn++) {
    if (ready()) return;
    await new Promise((wake) => setTimeout(wake, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Proves the room has read everything written before it. The queue is in
 * order, so an answer to this sits behind the frames under test — which is
 * what lets a test assert that something did NOT happen.
 */
async function readThrough(socket: Socket): Promise<void> {
  const fresh = new Doc();

  speak(socket, { type: 'syncStep1', stateVector: encodeStateVector(fresh) });
  fresh.destroy();
  await waitFor(() => kinds(socket).includes('syncStep2'), 'the answer to a syncStep1');
}

it('closes a member on its third malformed awareness frame, and says which frame was at fault', async () => {
  const peer = fakeSocket('blok-sync.v2');

  room.connect(asWebSocket(peer), 'editor', editor);
  // Never synced: a frame that will not parse is the sender's fault whether
  // or not it has read the document yet, which is how Go counts it.
  for (let frame = 0; frame < 2; frame++) speak(peer, awareness(5));
  await readThrough(peer);

  expect(peer.closed).toBeUndefined();

  speak(peer, awareness(5));
  await waitFor(() => peer.closed !== undefined, 'the close the third frame earns');

  expect(peer.closed).toEqual({ code: 1008, reason: 'malformed awareness' });
});

it('drops an awareness frame past the client cap without holding it against the member', async () => {
  const peer = fakeSocket('blok-sync.v2');

  room.connect(asWebSocket(peer), 'editor', editor);
  // 129 clients is past the reader's ceiling: dropped, and uncounted.
  for (let frame = 0; frame < 5; frame++) speak(peer, awareness(129));
  // 128 is at it, so these two are malformed — two is not three.
  speak(peer, awareness(128));
  speak(peer, awareness(128));
  await readThrough(peer);

  expect(peer.closed).toBeUndefined();

  speak(peer, awareness(128));
  await waitFor(() => peer.closed !== undefined, 'the close the third malformed frame earns');

  expect(peer.closed).toEqual({ code: 1008, reason: 'malformed awareness' });
});

it('relays a write between members that have not synced, which is how a stalled one is ever found', async () => {
  const writer = fakeSocket('');
  const reader = fakeSocket('');

  room.connect(asWebSocket(writer), 'editor', editor);
  room.connect(asWebSocket(reader), 'editor', editor);
  reader.sent.length = 0;

  const fresh = new Doc();

  fresh.getText('t').insert(0, 'hello');
  speak(writer, { type: 'update', update: encodeStateAsUpdate(fresh) });
  fresh.destroy();
  await waitFor(() => kinds(reader).includes('update'), 'the write to reach the other member');

  // Go puts no sync condition on either side of a v1 write: not on the
  // sender, and not on whoever it is relayed to. A reader that stopped
  // reading never syncs, so a sync condition would mean its outbound queue
  // never fills and a stalled consumer is never found at all.
  expect(kinds(reader)).toContain('update');
});
